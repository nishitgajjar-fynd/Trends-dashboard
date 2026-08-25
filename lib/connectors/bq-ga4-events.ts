/**
 * §16 — Connector 2: `bq-ga4-events` (GA4 → BigQuery export).
 *
 * P0. Powers `/journey`, the Scan Strip, and scan-level catalogue analysis.
 * Blocked on the dataset name — §13.1, and the single highest-leverage unblock
 * in the whole build. `discoverGa4Dataset()` below answers it in one query once
 * BigQuery access exists; nobody needs to be asked.
 */
import { config } from '@/lib/config';
import {
  cardinality,
  crossCheck,
  eventPresence,
  freshness,
  rowVolume,
  scanHygiene,
} from '@/lib/assertions';
import { EAN_SQL_FILTER, normalizeEan, type EanRejectReason } from '@/lib/format/ean';
import { normalizeStoreId } from '@/lib/format/keys';
import { bqSuffix, type DateWindow } from '@/lib/format/dates';
import { isBigQueryConfigured, listDatasets, runQuery, tableExists } from '@/lib/gcp/bigquery';
import { fixtureFunnel, FUNNEL_STEPS, type FunnelRow } from '@/fixtures/business';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

/** §16.3 — one param-extraction helper, used everywhere rather than hand-unnesting. */
export const PARAM_HELPERS = `
CREATE TEMP FUNCTION ps(params ANY TYPE, k STRING) AS (
  (SELECT value.string_value FROM UNNEST(params) WHERE key = k)
);
CREATE TEMP FUNCTION pi(params ANY TYPE, k STRING) AS (
  (SELECT COALESCE(value.int_value, CAST(value.double_value AS INT64))
   FROM UNNEST(params) WHERE key = k)
);
`.trim();

const ga4Table = () => `\`${config.bqGa4Project}.${config.bqGa4Dataset}.events_*\``;

/**
 * §16.1 — the authoritative event inventory. This query settles §5.2, and
 * answers the question Prince Chaudhary asked on 6 Aug that nobody replied to.
 * Run it first; commit the output to docs/source/EVENT_DICTIONARY.md.
 */
export const EVENT_INVENTORY_SQL = () => `
SELECT event_name, COUNT(*) AS n
FROM ${ga4Table()}
WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
GROUP BY 1
ORDER BY n DESC
LIMIT 200
`.trim();

/** §16.4 — funnel extraction. `_TABLE_SUFFIX` filtering is mandatory (§16.7). */
export const FUNNEL_SQL = () => `
${PARAM_HELPERS}
WITH ev AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date)  AS date_key,
    event_name,
    user_pseudo_id,
    pi(event_params, 'ga_session_id') AS ga_session_id,
    ps(event_params, 'store_id')      AS store_id,
    ps(event_params, 'platform')      AS platform,
    ps(event_params, 'sales_channel') AS sales_channel,
    app_info.version                  AS app_version,
    device.operating_system           AS os
  FROM ${ga4Table()}
  WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
),
sess AS (
  SELECT *, CONCAT(user_pseudo_id, '-', CAST(ga_session_id AS STRING)) AS session_key
  FROM ev
)
SELECT
  date_key, store_id, platform, app_version, event_name,
  COUNT(*)                       AS event_count,
  COUNT(DISTINCT session_key)    AS session_count,
  COUNT(DISTINCT user_pseudo_id) AS user_count
FROM sess
GROUP BY 1,2,3,4,5
`.trim();

/**
 * §16.5 — scan events → `fact_scan_daily`, with the EAN hygiene filter applied
 * in SQL so junk never reaches the mart (§16.5.1).
 */
export const SCAN_SQL = () => `
${PARAM_HELPERS}
SELECT
  PARSE_DATE('%Y%m%d', event_date)     AS date_key,
  -- Companion sends store_id and (real) ean as numeric params, so read them via pi().
  CAST(pi(event_params, 'store_id') AS STRING) AS store_id,
  REGEXP_REPLACE(TRIM(COALESCE(ps(event_params, 'ean'), CAST(pi(event_params, 'ean') AS STRING))), r'[^0-9]', '') AS ean,
  LOWER(ps(event_params, 'result'))    AS result,
  ps(event_params, 'platform')         AS platform,
  ps(event_params, 'sales_channel')    AS sales_channel,
  COUNT(*)                             AS scan_count,
  COUNT(DISTINCT CONCAT(user_pseudo_id,'-',CAST(pi(event_params,'ga_session_id') AS STRING))) AS session_count
FROM ${ga4Table()}
WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
  -- The scan-with-catalogue-result event carries ean + result + store (§16.5).
  AND event_name = 'scan_catalog_lookup'
  AND ps(event_params, 'result') IS NOT NULL
  AND ${EAN_SQL_FILTER}
GROUP BY 1,2,3,4,5,6
`.trim();

/** §13.11 — production fill-rate check for the seven scan-event params (A5). */
export const PARAM_FILL_SQL = () => `
${PARAM_HELPERS}
SELECT
  COUNTIF(ps(event_params,'ean')           IS NOT NULL) / COUNT(*) AS ean_fill,
  COUNTIF(ps(event_params,'store_id')      IS NOT NULL) / COUNT(*) AS store_fill,
  COUNTIF(ps(event_params,'result')        IS NOT NULL) / COUNT(*) AS result_fill,
  COUNTIF(ps(event_params,'sales_channel') IS NOT NULL) / COUNT(*) AS channel_fill,
  COUNTIF(ps(event_params,'platform')      IS NOT NULL) / COUNT(*) AS platform_fill,
  COUNTIF(ps(event_params,'session_id')    IS NOT NULL) / COUNT(*) AS session_fill,
  COUNT(*) AS scan_events
FROM ${ga4Table()}
WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
  AND ps(event_params,'result') IS NOT NULL
`.trim();

/**
 * §13.1 / A4 — find the export without waiting on anyone. GA4's default naming
 * is `analytics_<property_id>`, but the Loyalty property exports to a different
 * project, so candidates are probed rather than assumed.
 */
export async function discoverGa4Dataset(
  candidateProjects: string[] = [config.gcpProjectId],
): Promise<{ project: string; dataset: string } | null> {
  for (const project of candidateProjects) {
    try {
      const datasets = await listDatasets(project);
      const exact = datasets.find((d) => d === `analytics_${config.ga4PropertyId}`);
      if (exact) return { project, dataset: exact };
      const anyAnalytics = datasets.find((d) => d.startsWith('analytics_'));
      if (anyAnalytics) return { project, dataset: anyAnalytics };
    } catch {
      // Project not readable with this service account — try the next.
    }
  }
  return null;
}

interface RawFunnelRow {
  date_key: string;
  store_id: string | null;
  platform: string | null;
  app_version: string | null;
  event_name: string;
  event_count: number;
  session_count: number;
  user_count: number;
}

export class BqGa4EventsConnector extends BaseConnector<RawFunnelRow, FunnelRow> {
  readonly id = 'bq-ga4-events';
  readonly displayName = 'BigQuery — GA4 event export';
  readonly freshnessSlaMinutes = 48 * 60; // GA4 daily export lands with real lag
  readonly costTier: CostTier = 'expensive'; // §27.6 — the main cost risk
  readonly priority = 'P0' as const;
  readonly powers = ['/journey', 'Scan Strip', 'fact_scan_daily', 'scan_success_rate', 'unique_coverage'];
  readonly blockedBy = '§13.1 GA4→BQ dataset name (unknown); §13.2 GCP service account';

  isConfigured(): boolean {
    return isBigQueryConfigured() && Boolean(config.bqGa4Project) && Boolean(config.bqGa4Dataset);
  }

  /** §16.6 — intraday drives the Scan Strip; never union it with daily tables. */
  async hasIntraday(dateKey: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    return tableExists(config.bqGa4Dataset, `events_intraday_${bqSuffix(dateKey)}`, config.bqGa4Project);
  }

  protected async extract(w: DateWindow): Promise<RawFunnelRow[]> {
    const res = await runQuery<RawFunnelRow>({
      query: FUNNEL_SQL(),
      params: { suffix_start: bqSuffix(w.start), suffix_end: bqSuffix(w.end) },
      types: { suffix_start: 'STRING', suffix_end: 'STRING' },
      connector: this.id,
    });
    return res.rows;
  }

  protected transform(rows: RawFunnelRow[]): FunnelRow[] {
    // Match on the real GA4 event name (`eventName`) when a step declares one —
    // Companion's terminal step is the `payment_success` event, not `purchase`.
    const stepByEvent = new Map(FUNNEL_STEPS.map((s) => [s.eventName ?? s.step, s]));
    const out: FunnelRow[] = [];
    const seenSteps = new Set<string>();

    for (const r of rows) {
      const def = stepByEvent.get(r.event_name);
      if (!def) continue; // not a funnel event — kept out of fact_funnel_daily
      seenSteps.add(def.step);
      out.push({
        dateKey: r.date_key,
        storeId: normalizeStoreId(r.store_id),
        platform: r.platform ?? '',
        appVersion: r.app_version ?? '',
        step: def.step,
        stepOrder: def.order,
        eventCount: Number(r.event_count),
        sessionCount: Number(r.session_count),
        userCount: Number(r.user_count),
        isInstrumented: true,
      });
    }

    // §16.9 — an expected funnel event with zero rows is written as
    // `is_instrumented = false`, never as a zero. The UI renders it as a hatched
    // "not instrumented" step. Known likely gaps: failed-scan GTM events,
    // apply-promotion failure events, and invoice/de-tag (A6) — the last step of
    // the core journey is probably invisible today, and that belongs on the
    // dashboard as a gap because it is a sprint ticket waiting to be written.
    const dates = [...new Set(rows.map((r) => r.date_key))];
    for (const def of FUNNEL_STEPS) {
      if (seenSteps.has(def.step)) continue;
      for (const dateKey of dates) {
        out.push({
          dateKey,
          storeId: '',
          platform: '',
          appVersion: '',
          step: def.step,
          stepOrder: def.order,
          eventCount: 0,
          sessionCount: 0,
          userCount: 0,
          isInstrumented: false,
        });
      }
    }
    return out;
  }

  protected async load(rows: FunnelRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factFunnelDaily } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_funnel_daily' };

    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(factFunnelDaily)
        .values(rows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [
            factFunnelDaily.dateKey,
            factFunnelDaily.storeId,
            factFunnelDaily.platform,
            factFunnelDaily.appVersion,
            factFunnelDaily.step,
          ],
          set: {
            eventCount: sql`excluded.event_count`,
            sessionCount: sql`excluded.session_count`,
            userCount: sql`excluded.user_count`,
            isInstrumented: sql`excluded.is_instrumented`,
          },
        });
    }
    return { rowsIngested: rows.length, table: 'fact_funnel_daily' };
  }

  protected fixture(w: DateWindow): FunnelRow[] {
    return fixtureFunnel(w);
  }

  readonly assertions: Assertion<FunnelRow>[] = [
    freshness<FunnelRow>({ column: 'dateKey', maxLagHours: 48, level: 'fail' }),
    rowVolume<FunnelRow>({ tolerance: 0.6, zeroIsFail: true }),
    eventPresence<FunnelRow>({ required: ['session_start'], level: 'fail' }),
    cardinality<FunnelRow>({ column: 'storeId', minDistinct: 50, level: 'warn' }),
    // §16.8 — the cheapest early-warning signal available: GA4 `purchase` count
    // vs BQ order count. They never match exactly, but a widening gap means
    // either instrumentation broke or the order pipeline did.
    crossCheck<FunnelRow>({
      id: 'ga4_purchases_vs_orders',
      left: (rows) =>
        rows.filter((r) => r.step === 'purchase').reduce((a, r) => a + r.eventCount, 0) || null,
      right: async () => {
        try {
          const { getDb } = await import('@/lib/db/client');
          const { factOrders } = await import('@/lib/db/schema');
          const { sql } = await import('drizzle-orm');
          const db = getDb();
          if (!db) return null;
          const res = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(factOrders);
          return res[0]?.n ?? null;
        } catch {
          return null;
        }
      },
      tolerance: 0.1,
      level: 'warn',
    }),
  ];
}

/* ── Scan-side ingestion (§16.5) ─────────────────────────────────────────── */

export interface ScanAggregateRow {
  dateKey: string;
  storeId: string;
  ean: string;
  result: 'found' | 'not_found';
  platform: string;
  salesChannel: string;
  scanCount: number;
  sessionCount: number;
}

export interface ScanRejection {
  dateKey: string;
  storeId: string;
  reason: EanRejectReason;
  scanCount: number;
  sampleValues: string[];
}

/**
 * Row-level EAN hygiene, applied on the TypeScript side so rejects are recorded
 * rather than silently dropped (§16.5.1). The SQL filter prunes the bulk; this
 * catches and classifies what a raw (unfiltered) pull contains.
 */
export function partitionScanRows(
  raw: Array<{ dateKey: string; storeId: string; ean: unknown; result: string; platform?: string; salesChannel?: string; scanCount: number; sessionCount?: number }>,
): { valid: ScanAggregateRow[]; rejected: ScanRejection[]; rejectionRate: number } {
  const valid: ScanAggregateRow[] = [];
  const rejectMap = new Map<string, ScanRejection>();
  let rejectedScans = 0;
  let totalScans = 0;

  for (const r of raw) {
    totalScans += r.scanCount;
    const verdict = normalizeEan(r.ean);
    if (verdict.ok) {
      valid.push({
        dateKey: r.dateKey,
        storeId: normalizeStoreId(r.storeId),
        ean: verdict.ean,
        result: r.result === 'found' ? 'found' : 'not_found',
        platform: r.platform ?? '',
        salesChannel: r.salesChannel ?? '',
        scanCount: r.scanCount,
        sessionCount: r.sessionCount ?? 0,
      });
    } else {
      rejectedScans += r.scanCount;
      const key = `${r.dateKey}|${r.storeId}|${verdict.reason}`;
      const cur = rejectMap.get(key) ?? {
        dateKey: r.dateKey,
        storeId: normalizeStoreId(r.storeId),
        reason: verdict.reason,
        scanCount: 0,
        sampleValues: [],
      };
      cur.scanCount += r.scanCount;
      if (cur.sampleValues.length < 5) cur.sampleValues.push(verdict.raw);
      rejectMap.set(key, cur);
    }
  }

  return {
    valid,
    rejected: [...rejectMap.values()],
    rejectionRate: totalScans === 0 ? 0 : rejectedScans / totalScans,
  };
}

/** The hygiene assertion, wired to the same partition function. */
export const scanHygieneAssertion = scanHygiene<{ rejectionRate: number }>({
  rate: (rows) => rows[0]?.rejectionRate ?? 0,
  warnAbove: 0.02,
  failAbove: 0.15,
});

export const bqGa4Events = new BqGa4EventsConnector();
