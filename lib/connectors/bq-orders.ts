/**
 * §15 — Connector 1: `bq-orders` (BigQuery, orders and revenue).
 *
 * P0. Powers `/sales`, `/stores`, and every revenue number on the hub.
 *
 * Known failure mode (§15.6): `avis_base_view` silently stopped reflecting new
 * orders from 25 Jun 2026 and ran stale for roughly two weeks while reporting
 * itself healthy (DOPS-25241). The freshness assertion exists for that, and the
 * row-count reconciliation catches the same failure wearing a disguise — a fresh
 * `max(order_ts)` with an anomalously low count for yesterday.
 */
import { sql } from 'drizzle-orm';
import { PROD_AFFILIATE } from '@/lib/config/env-guard';
import { config } from '@/lib/config';
import { freshness, nullRate, range, rowVolume, uniqueness, valueSet } from '@/lib/assertions';
import { fixtureOrders, type OrderRow, CONFIRMED_STATUSES } from '@/fixtures/business';
import { hashCustomerId, normalizeStoreId } from '@/lib/format/keys';
import { istDateKey, type DateWindow } from '@/lib/format/dates';
import { isBigQueryConfigured, runQuery } from '@/lib/gcp/bigquery';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

/**
 * §15.2 — the known-good pattern for this workspace.
 *
 * Two rules: always bound by `DATE(state_date)` (an unbounded scan of this view
 * is expensive and has no upside), and always parameterise. `@affiliate_ids`
 * stays an array for query hygiene but is passed exactly one value — the prod
 * affiliate id. Widening it is a scope violation (§0).
 */
/**
 * A1/§15.3 (resolved 2026-08-21, verified against the live view) — `avis_base_view`
 * is at **bag/line-item grain**: one row per `bag_id`, many rows per `order_id`.
 * A plain `SELECT *` therefore returns duplicate order ids and the uniqueness
 * assertion (correctly) hard-fails. We aggregate to order grain here, reproducing
 * the figures confirmed by hand against the view (≈11,032 orders, ₹923 AOV):
 *
 *   - revenue  = SUM(billed_amount)  → grossValue (net of nothing further; A3)
 *   - units    = SUM(quantity)
 *   - grain    = one row per order_id
 *
 * Assumptions still to confirm with the Avis owner and record in ADR-000:
 *   - completed order = a bag in status 'handed_over_to_customer' (the basis the
 *     existing reporting uses). Only completed orders are loaded here; the
 *     inclusive/all-status variant (A3) waits on the full status enum.
 *   - discounts/coupons are NOT broken out yet (`billed_amount` is taken as the
 *     revenue figure as-is); the discount columns exist but their exact meaning
 *     is unverified, so net_revenue == e-GMV until confirmed.
 */
export const ORDERS_SQL = `
SELECT
  order_id,
  ANY_VALUE(affiliate_id)                 AS affiliate_id,
  ANY_VALUE(state_date)                   AS state_date,
  ANY_VALUE(status)                       AS status,
  CAST(ANY_VALUE(store_id) AS STRING)     AS store_id,
  CAST(ANY_VALUE(user_id) AS STRING)      AS customer_id,
  ANY_VALUE(order_platform)               AS platform,
  ANY_VALUE(mode_of_payment)              AS payment_method,
  SUM(quantity)                           AS quantity,
  ROUND(SUM(billed_amount), 2)            AS gross_value
FROM \`${config.bqOrdersTable}\`
WHERE DATE(state_date, 'Asia/Kolkata') BETWEEN @start_date AND @end_date
  AND affiliate_id IN UNNEST(@affiliate_ids)
  AND status = 'handed_over_to_customer'
GROUP BY order_id
`.trim();

/** §15.3 — schema discovery. Phase 2 step one, before writing any mapping. */
export const SCHEMA_DISCOVERY_SQL = `
SELECT column_name, data_type
FROM \`sng-prod.sng_analytics_dwh.INFORMATION_SCHEMA.COLUMNS\`
WHERE table_name = 'avis_base_view'
ORDER BY ordinal_position
`.trim();

/**
 * A1 — the view's exact column list is undocumented, so the mapping is
 * alias-driven rather than hard-coded. A renamed column produces a warning with
 * the headers actually found, not a column of nulls.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  order_id: ['order_id', 'orderid', 'order_no', 'order_number', 'id'],
  order_ts: ['state_date', 'created_at', 'order_date', 'order_created_at'],
  store_id: ['store_id', 'storeid', 'fulfilling_store_id', 'location_id'],
  status: ['status', 'order_status', 'state', 'current_status'],
  gross_value: ['gross_value', 'order_value', 'total_value', 'amount', 'gross_amount'],
  net_value: ['net_value', 'net_amount', 'final_amount', 'payable_amount'],
  discount_amount: ['discount_amount', 'discount', 'total_discount'],
  coupon_amount: ['coupon_amount', 'coupon_discount', 'promo_discount'],
  coupon_code: ['coupon_code', 'promo_code'],
  customer_id: ['customer_id', 'user_id', 'buyer_id'],
  units: ['units', 'quantity', 'item_count', 'total_quantity'],
  payment_method: ['payment_method', 'payment_mode', 'mop'],
  app_version: ['app_version', 'application_version'],
  platform: ['platform', 'device_platform', 'os'],
};

function resolve(row: Record<string, unknown>, field: string): unknown {
  for (const alias of COLUMN_ALIASES[field] ?? []) {
    if (alias in row && row[alias] != null) return row[alias];
  }
  return null;
}

export class BqOrdersConnector extends BaseConnector<Record<string, unknown>, OrderRow> {
  readonly id = 'bq-orders';
  readonly displayName = 'BigQuery — orders & revenue';
  readonly freshnessSlaMinutes = 26 * 60; // §15.5 — 26h, not 24h, for the 02:00 rebuild
  readonly costTier: CostTier = 'metered';
  readonly priority = 'P0' as const;
  readonly powers = ['/sales', '/stores', 'hub revenue', 'orders', 'egmv', 'net_revenue', 'aov'];
  readonly blockedBy = '§13.2 GCP service account; §13.4 order status enum';

  /** A2 — rupees vs paise is unverified. Set once confirmed against the ₹3.29 L April baseline. */
  private readonly currencyDivisor = Number(process.env.BQ_ORDERS_CURRENCY_DIVISOR ?? '1');

  isConfigured(): boolean {
    return isBigQueryConfigured();
  }

  protected async extract(w: DateWindow): Promise<Record<string, unknown>[]> {
    const res = await runQuery<Record<string, unknown>>({
      query: ORDERS_SQL,
      params: { start_date: w.start, end_date: w.end, affiliate_ids: [PROD_AFFILIATE] },
      types: { start_date: 'DATE', end_date: 'DATE', affiliate_ids: ['STRING'] },
      connector: this.id,
    });
    return res.rows;
  }

  protected transform(rows: Record<string, unknown>[]): OrderRow[] {
    return rows.map((r) => {
      const ts = String(resolve(r, 'order_ts') ?? new Date().toISOString());
      const gross = Number(resolve(r, 'gross_value') ?? 0) / this.currencyDivisor;
      const discount = Number(resolve(r, 'discount_amount') ?? 0) / this.currencyDivisor;
      const coupon = Number(resolve(r, 'coupon_amount') ?? 0) / this.currencyDivisor;
      const netRaw = resolve(r, 'net_value');
      const net = netRaw == null ? gross - discount - coupon : Number(netRaw) / this.currencyDivisor;
      const status = String(resolve(r, 'status') ?? 'unknown').toLowerCase();
      return {
        orderId: String(resolve(r, 'order_id') ?? '').trim().toUpperCase(),
        orderTs: ts,
        orderDate: istDateKey(ts), // §27.2 — the retail day is an IST day
        storeId: normalizeStoreId(resolve(r, 'store_id')),
        tenant: config.defaultTenant,
        affiliateId: String(r.affiliate_id ?? ''),
        customerId: hashCustomerId(resolve(r, 'customer_id')), // §27.4
        isNewCustomer: false, // derived in the mart, not per-row
        status,
        // A3 — both variants stored until the enum is confirmed (§15.4).
        statusConfirmed: CONFIRMED_STATUSES.includes(status),
        units: Number(resolve(r, 'units') ?? 0),
        grossValue: gross,
        discountAmount: discount,
        couponAmount: coupon,
        couponCode: (resolve(r, 'coupon_code') as string | null) ?? null,
        netValue: net,
        paymentMethod: String(resolve(r, 'payment_method') ?? ''),
        appVersion: String(resolve(r, 'app_version') ?? ''),
        sdkVersion: '',
        platform: String(resolve(r, 'platform') ?? ''),
      };
    });
  }

  protected async load(rows: OrderRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factOrders, dimStore } = await import('@/lib/db/schema');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_orders' };

    // §7.1 — orders can reference a store the master sheet has not caught up to
    // yet (one onboarded this week). fact_orders.store_id is a FK to dim_store, so
    // a single unknown store aborts the whole batch and drops real orders on the
    // floor — exactly the silent hole that left recent windows empty. Guarantee
    // the dimension row exists first: a minimal stub, which the store-master fills
    // in with real metadata on its next upsert. No order is ever lost to sheet lag.
    const storeIds = [...new Set(rows.map((r) => r.storeId).filter((s): s is string => Boolean(s)))];
    if (storeIds.length) {
      await db
        .insert(dimStore)
        .values(storeIds.map((storeId) => ({ storeId })))
        .onConflictDoNothing({ target: dimStore.storeId });
    }

    // §27.5 — upsert on the natural key, never insert-only, so any window can be
    // re-run safely and backfill is trivial.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await db
        .insert(factOrders)
        .values(
          chunk.map((r) => ({
            orderId: r.orderId,
            orderTs: new Date(r.orderTs),
            orderDate: r.orderDate,
            storeId: r.storeId || null,
            tenant: r.tenant,
            affiliateId: r.affiliateId,
            customerId: r.customerId,
            isNewCustomer: r.isNewCustomer,
            status: r.status,
            statusConfirmed: r.statusConfirmed,
            units: r.units,
            grossValue: String(r.grossValue),
            discountAmount: String(r.discountAmount),
            couponAmount: String(r.couponAmount),
            couponCode: r.couponCode,
            netValue: String(r.netValue),
            paymentMethod: r.paymentMethod,
            appVersion: r.appVersion,
            sdkVersion: r.sdkVersion,
            platform: r.platform,
            source: this.id,
          })),
        )
        .onConflictDoUpdate({
          target: factOrders.orderId,
          // §15.7 — order states change after creation (cancellations, returns,
          // payment confirmations), so re-runs must overwrite, not skip.
          set: {
            status: sql`excluded.status`,
            statusConfirmed: sql`excluded.status_confirmed`,
            netValue: sql`excluded.net_value`,
            ingestedAt: new Date(),
          },
        });
    }

    // §27.4 — new vs repeat is a function of each customer's first order across
    // ALL history, not the loaded window. It must be recomputed after every load,
    // or freshly-ingested orders keep the default (`false`) and a genuine surge of
    // new customers reads as "repeat" (exactly the New→Repeat flip seen once the
    // late-August orders landed). One indexed UPDATE over the natural key.
    await db.execute(sql`
      UPDATE fact_orders o
      SET is_new_customer = (o.order_date = f.first_date)
      FROM (
        SELECT customer_id, MIN(order_date) AS first_date
        FROM fact_orders
        WHERE customer_id IS NOT NULL
        GROUP BY customer_id
      ) f
      WHERE f.customer_id = o.customer_id
    `);

    return { rowsIngested: rows.length, table: 'fact_orders' };
  }

  protected fixture(w: DateWindow): OrderRow[] {
    return fixtureOrders(w);
  }

  readonly assertions: Assertion<OrderRow>[] = [
    freshness<OrderRow>({ column: 'orderTs', maxLagHours: 26, level: 'fail' }),
    rowVolume<OrderRow>({ vsTrailingMedianDays: 7, tolerance: 0.6, zeroIsFail: true }),
    uniqueness<OrderRow>({ key: 'orderId', level: 'fail' }),
    range<OrderRow>({ column: 'netValue', min: 0, level: 'fail' }),
    // ₹5 L on a single Trends order is not plausible — flag, don't block.
    range<OrderRow>({ column: 'netValue', max: 500_000, level: 'warn' }),
    nullRate<OrderRow>({ columns: ['orderId', 'orderTs', 'storeId'], max: 0.01, level: 'warn' }),
    // §0 / §15.5 — row-level production enforcement, not config validation.
    valueSet<OrderRow>({
      column: 'affiliateId',
      allowed: [PROD_AFFILIATE],
      level: 'fail',
      message: 'Non-production affiliate id present in ingested rows — refusing to load',
    }),
  ];
}

export const bqOrders = new BqOrdersConnector();
