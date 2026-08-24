/**
 * §19 — Connector 4: `sheets-store-master`.
 *
 * P0. Nothing store-level works without `dim_store`.
 *
 * Two disciplines this connector exists to enforce: store codes are text and
 * keep their leading zeros (§19.3), and header drift produces a warning naming
 * the headers actually found rather than a silent column of nulls (§19.4).
 */
import { config } from '@/lib/config';
import { cardinality, nullRate, rowVolume, uniqueness } from '@/lib/assertions';
import { normalizeStoreCode, normalizeStoreId } from '@/lib/format/keys';
import { FIXTURE_STORES, type FixtureStore } from '@/fixtures/stores';
import { getAccessToken, isGcpConfigured } from '@/lib/gcp/auth';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** §19.4 — headers drift. Normalise, then map through an explicit alias table. */
const ALIASES: Record<string, string[]> = {
  store_id: ['store_id', 'storeid', 'store id', 'platform_store_id', 'platform store id'],
  store_code: ['store_code', 'storecode', 'store code', 'rt_code', 'trends_code', 'rt code'],
  store_name: ['store_name', 'name', 'store', 'store name'],
  city: ['city', 'location'],
  state: ['state'],
  region: ['region', 'zone'],
  activated_on: ['activated_on', 'activation_date', 'go_live_date', 'live_date'],
};

const REQUIRED = ['store_id', 'store_code'];

function snake(h: string): string {
  return String(h).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

export function mapHeaders(headers: string[]): {
  index: Record<string, number>;
  warnings: string[];
} {
  const normalised = headers.map(snake);
  const index: Record<string, number> = {};
  const warnings: string[] = [];

  for (const [field, aliases] of Object.entries(ALIASES)) {
    const i = normalised.findIndex((h) => aliases.includes(h) || aliases.includes(h.replace(/_/g, ' ')));
    if (i >= 0) index[field] = i;
    else if (REQUIRED.includes(field)) {
      // Hard-fail with the actual headers in the message, so the fix is obvious.
      throw new Error(
        `Required column "${field}" not found in store master. Headers present: ${headers.join(' | ')}`,
      );
    } else {
      warnings.push(`Optional column "${field}" not found — will be null`);
    }
  }
  return { index, warnings };
}

interface SheetRow {
  values: string[];
}

export class SheetsStoreMasterConnector extends BaseConnector<SheetRow, FixtureStore> {
  readonly id = 'sheets-store-master';
  readonly displayName = 'Google Sheets — store master';
  readonly freshnessSlaMinutes = 36 * 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P0' as const;
  readonly powers = ['dim_store', '/stores', 'store & state rollups', 'deep-link builder', 'stores_live'];
  readonly blockedBy = '§13.3 store master sheet contents; §13.2 Sheets read access';

  private headerWarnings: string[] = [];

  isConfigured(): boolean {
    return (isGcpConfigured() && Boolean(config.sheetStoreMasterId)) || this.hasLocalCsv();
  }

  /**
   * §19.5 — when the API is not configured, read the Appendix A.2 CSV export
   * from `/docs/source`. Same interface, different extract. This is the pattern
   * for every Sheets/Drive/Quip source.
   */
  private csvPath(): string {
    return join(process.cwd(), 'docs', 'source', 'store_master.csv');
  }

  private hasLocalCsv(): boolean {
    try {
      return existsSync(this.csvPath());
    } catch {
      return false;
    }
  }

  protected async extract(): Promise<SheetRow[]> {
    if (isGcpConfigured() && config.sheetStoreMasterId) {
      try {
        const token = await getAccessToken();
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetStoreMasterId}/values/A:Z?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Sheets ${res.status}: ${await res.text()}`);
        const body = (await res.json()) as { values?: unknown[][] };
        return (body.values ?? []).map((row) => ({ values: row.map((c) => String(c ?? '')) }));
      } catch (e) {
        // §19.5 / RUNBOOK — the Sheets API can be unavailable (personal ADC has
        // no Sheets scope, or the sheet isn't shared). Fall back to the Appendix
        // A.2 CSV export if one is present, rather than failing the whole store
        // dimension — everything store-level depends on it.
        if (!this.hasLocalCsv()) throw e;
        this.headerWarnings.push(
          `Sheets API unavailable (${(e as Error).message.slice(0, 80)}) — served from docs/source/store_master.csv`,
        );
      }
    }
    return this.readCsv();
  }

  private readCsv(): SheetRow[] {
    const csv = readFileSync(this.csvPath(), 'utf8');
    return csv
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((line) => ({ values: parseCsvLine(line) }));
  }

  protected transform(rows: SheetRow[]): FixtureStore[] {
    if (rows.length === 0) return [];
    const { index, warnings } = mapHeaders(rows[0].values);
    this.headerWarnings = warnings;

    const at = (r: string[], field: string): string =>
      index[field] === undefined ? '' : (r[index[field]] ?? '').toString().trim();

    return rows.slice(1).map((row) => {
      const r = row.values;
      // §19.3 — never Number(). `00421` must stay `00421`.
      const { code, warning } = normalizeStoreCode(at(r, 'store_code'));
      if (warning) this.headerWarnings.push(warning);
      return {
        storeId: normalizeStoreId(at(r, 'store_id')),
        storeCode: code,
        storeName: at(r, 'store_name'),
        city: at(r, 'city'),
        state: at(r, 'state'),
        region: at(r, 'region'),
        tenant: config.defaultTenant,
        companionLive: true, // presence in the master means enabled
        activatedOn: at(r, 'activated_on') || null,
        lat: 0,
        lon: 0,
      };
    });
  }

  protected async load(rows: FixtureStore[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { dimStore } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'dim_store' };

    // §0 — warn and exclude if the master contains test stores, so pre-prod
    // stores never pollute production numbers.
    const clean = rows.filter((r) => !/\b(test|uat|dummy|demo)\b/i.test(r.storeName || r.storeCode));

    await db
      .insert(dimStore)
      .values(
        clean.map((r) => ({
          storeId: r.storeId,
          storeCode: r.storeCode,
          storeName: r.storeName,
          city: r.city,
          state: r.state,
          region: r.region,
          tenant: r.tenant,
          companionLive: r.companionLive,
          activatedOn: r.activatedOn,
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
          updatedAt: new Date(),
        },
      });
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

/** Minimal CSV line parser that respects quoted fields containing commas. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export const sheetsStoreMaster = new SheetsStoreMasterConnector();
