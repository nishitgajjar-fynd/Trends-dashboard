/**
 * §19 — Connector: `bq-store-master`.
 *
 * P0. Nothing store-level works without `dim_store`.
 *
 * The store master comes from BigQuery, not a spreadsheet: `orbis_store` in
 * `orbis_pipe_dwh` is the authoritative Orbis feed, and its `uid` matches the
 * `store_id` on orders and scans 1:1 (verified: 425/425 order stores join). We
 * scope to `company_id = 1` (Reliance Trends) — every Trends store, whether or
 * not Companion is live there, so `stores_live` means "exists in the estate".
 *
 * Orbis is a Datastream CDC table (`data` is a JSON document, one row per
 * change), so the extract takes the latest row per `uid` by partition time.
 */
import { config } from '@/lib/config';
import { cardinality, nullRate, rowVolume, uniqueness } from '@/lib/assertions';
import { normalizeStoreCode, normalizeStoreId } from '@/lib/format/keys';
import { FIXTURE_STORES, type FixtureStore } from '@/fixtures/stores';
import { isBigQueryConfigured, runQuery } from '@/lib/gcp/bigquery';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

/**
 * State → operating zone. Orbis carries the state but no region, and the store
 * and state rollups group by it, so a store with no zone would fall into an
 * unlabelled bucket. Covers every state/UT present in the Trends estate.
 */
const REGION_BY_STATE: Record<string, string> = {
  // North
  Delhi: 'North', Haryana: 'North', Punjab: 'North', 'Himachal Pradesh': 'North',
  'Jammu And Kashmir': 'North', Uttarakhand: 'North', 'Uttar Pradesh': 'North',
  Chandigarh: 'North', Rajasthan: 'North',
  // South
  'Andhra Pradesh': 'South', Karnataka: 'South', Kerala: 'South', 'Tamil Nadu': 'South',
  Telangana: 'South', Puducherry: 'South',
  // East
  Bihar: 'East', Jharkhand: 'East', Odisha: 'East', 'West Bengal': 'East',
  // West
  Goa: 'West', Gujarat: 'West', Maharashtra: 'West',
  'Dadra & Nagar Haveli And Daman & Diu': 'West',
  // Central
  Chhattisgarh: 'Central', 'Madhya Pradesh': 'Central',
  // North-East
  'Arunachal Pradesh': 'North-East', Assam: 'North-East', Manipur: 'North-East',
  Meghalaya: 'North-East', Nagaland: 'North-East', Sikkim: 'North-East', Tripura: 'North-East',
};

interface OrbisStoreRow {
  store_id: string | null;
  store_code: string | null;
  store_name: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
}

export class BqStoreMasterConnector extends BaseConnector<OrbisStoreRow, FixtureStore> {
  readonly id = 'bq-store-master';
  readonly displayName = 'BigQuery — store master (Orbis)';
  readonly freshnessSlaMinutes = 36 * 60;
  readonly costTier: CostTier = 'metered';
  readonly priority = 'P0' as const;
  readonly powers = ['dim_store', '/stores', 'store & state rollups', 'deep-link builder', 'stores_live'];
  readonly blockedBy = '§13.2 BigQuery read access to orbis_pipe_dwh';

  isConfigured(): boolean {
    return isBigQueryConfigured();
  }

  protected async extract(): Promise<OrbisStoreRow[]> {
    // Latest CDC row per uid, scoped to Reliance Trends. `coordinates` is
    // GeoJSON [lon, lat]; SAFE_CAST tolerates the stores with no location.
    const sql = `
      WITH latest AS (
        SELECT
          JSON_VALUE(data, '$.uid')                                                 AS store_id,
          JSON_VALUE(data, '$.store_code')                                          AS store_code,
          COALESCE(JSON_VALUE(data, '$.display_name'), JSON_VALUE(data, '$.name'))  AS store_name,
          JSON_VALUE(data, '$.address.city')                                        AS city,
          JSON_VALUE(data, '$.address.state')                                       AS state,
          SAFE_CAST(JSON_VALUE(data, '$.address.lat_long.coordinates[1]') AS FLOAT64) AS lat,
          SAFE_CAST(JSON_VALUE(data, '$.address.lat_long.coordinates[0]') AS FLOAT64) AS lon,
          ROW_NUMBER() OVER (PARTITION BY JSON_VALUE(data, '$.uid') ORDER BY _PARTITIONTIME DESC) AS rn
        FROM \`${config.bqStoreTable}\`
        WHERE JSON_VALUE(data, '$.company_id') = @company_id
      )
      SELECT store_id, store_code, store_name, city, state, lat, lon
      FROM latest
      WHERE rn = 1 AND store_id IS NOT NULL`;
    const res = await runQuery<OrbisStoreRow>({
      query: sql,
      params: { company_id: config.bqStoreCompanyId },
      types: { company_id: 'STRING' },
      connector: this.id,
    });
    return res.rows;
  }

  protected transform(rows: OrbisStoreRow[]): FixtureStore[] {
    return rows.map((r) => {
      // §19.3 — codes are text and keep leading zeros; ids are never Number().
      const { code } = normalizeStoreCode(String(r.store_code ?? ''));
      const state = (r.state ?? '').trim();
      const inRange = (n: number | null): number | null =>
        n != null && Number.isFinite(n) && Math.abs(n) <= 180 && n !== 0 ? n : null;
      return {
        storeId: normalizeStoreId(String(r.store_id ?? '')),
        storeCode: code,
        storeName: (r.store_name ?? '').trim(),
        city: (r.city ?? '').trim(),
        state,
        region: REGION_BY_STATE[state] ?? '',
        tenant: config.defaultTenant,
        companionLive: true, // §A — every company_id=1 store is in the Trends estate
        activatedOn: null,
        lat: inRange(r.lat),
        lon: inRange(r.lon),
      };
    });
  }

  protected async load(rows: FixtureStore[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { dimStore } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'dim_store' };

    // §0 — never let pre-prod stores pollute production numbers.
    const clean = rows.filter((r) => !/\b(test|uat|dummy|demo)\b/i.test(r.storeName || r.storeCode));

    // Chunked: the estate is a few thousand rows, over Postgres' parameter limit
    // in a single statement.
    for (let i = 0; i < clean.length; i += 500) {
      const chunk = clean.slice(i, i + 500);
      await db
        .insert(dimStore)
        .values(
          chunk.map((r) => ({
            storeId: r.storeId,
            storeCode: r.storeCode,
            storeName: r.storeName,
            city: r.city,
            state: r.state,
            region: r.region,
            tenant: r.tenant,
            companionLive: r.companionLive,
            lat: r.lat == null ? null : String(r.lat),
            lon: r.lon == null ? null : String(r.lon),
          })),
        )
        .onConflictDoUpdate({
          target: dimStore.storeId,
          set: {
            storeCode: sql`excluded.store_code`,
            storeName: sql`excluded.store_name`,
            city: sql`excluded.city`,
            state: sql`excluded.state`,
            region: sql`excluded.region`,
            companionLive: sql`excluded.companion_live`,
            lat: sql`excluded.lat`,
            lon: sql`excluded.lon`,
            updatedAt: new Date(),
          },
        });
    }
    return { rowsIngested: clean.length, table: 'dim_store' };
  }

  protected fixture(): FixtureStore[] {
    return FIXTURE_STORES;
  }

  readonly assertions: Assertion<FixtureStore>[] = [
    uniqueness<FixtureStore>({ key: 'storeId', level: 'fail' }),
    rowVolume<FixtureStore>({ tolerance: 0.6, zeroIsFail: true }),
    nullRate<FixtureStore>({ columns: ['storeId', 'storeCode'], max: 0.01, level: 'fail' }),
    nullRate<FixtureStore>({ columns: ['city', 'state'], max: 0.2, level: 'warn' }),
    cardinality<FixtureStore>({ column: 'city', minDistinct: 5, level: 'warn' }),
  ];
}

export const bqStoreMaster = new BqStoreMasterConnector();
