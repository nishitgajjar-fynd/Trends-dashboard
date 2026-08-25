/**
 * §17 — Connector 5: `ga4-api` (GA4 Data API). P1.
 *
 * Complements the BQ export; does not replace it.
 *
 * §17.2 is the constraint that trips people up: `store_id`, `ean`, `result` and
 * `sales_channel` are event-scoped custom parameters. They are queryable in
 * BigQuery immediately, but only queryable via the Data API if someone registers
 * them as custom dimensions. Check the registration state first — do not spend a
 * day debugging empty API responses.
 *
 * §17.5 — if a Data API figure disagrees with BigQuery, BigQuery is right. Any
 * card sourceable from both shows the BQ value and uses the API only as a
 * freshness hint.
 */
import { config } from '@/lib/config';
import { rowVolume } from '@/lib/assertions';
import type { DateWindow } from '@/lib/format/dates';
import { getAccessToken, isGcpConfigured } from '@/lib/gcp/auth';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

export interface Ga4AggregateRow {
  dateKey: string;
  eventName: string;
  platform: string;
  appVersion: string;
  eventCount: number;
  sessions: number;
  activeUsers: number;
  totalRevenue: number;
  transactions: number;
}

export interface CustomDimension {
  parameterName: string;
  displayName: string;
  scope: string;
}

/** §17.2 — record the finding in docs/source/GA4_CUSTOM_DIMENSIONS.md. */
export async function listCustomDimensions(): Promise<CustomDimension[]> {
  if (!isGcpConfigured()) return [];
  const token = await getAccessToken();
  const res = await fetch(
    `https://analyticsadmin.googleapis.com/v1beta/properties/${config.ga4PropertyId}/customDimensions`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { customDimensions?: CustomDimension[] };
  return body.customDimensions ?? [];
}

export async function scanParamsAreRegistered(): Promise<{
  registered: string[];
  missing: string[];
}> {
  const needed = ['store_id', 'ean', 'result', 'sales_channel'];
  const dims = await listCustomDimensions();
  const names = new Set(dims.map((d) => d.parameterName));
  return {
    registered: needed.filter((n) => names.has(n)),
    missing: needed.filter((n) => !names.has(n)),
  };
}

export class Ga4ApiConnector extends BaseConnector<Ga4AggregateRow, Ga4AggregateRow> {
  readonly id = 'ga4-api';
  readonly displayName = 'GA4 Data API — quick aggregates';
  readonly freshnessSlaMinutes = 90;
  readonly costTier: CostTier = 'free'; // quota-limited rather than billed
  readonly priority = 'P1' as const;
  readonly powers = ['realtime hub indicators', 'BQ cross-check'];
  readonly blockedBy = '§13.2 service account added to GA4 property; A8 custom dimension registration';

  isConfigured(): boolean {
    // Opt-in. The GA4 Data API needs a service account added to the property (A8)
    // — a different grant than ADC, so it 403s (ACCESS_TOKEN_SCOPE_INSUFFICIENT).
    // The GA4 BigQuery export (bq-ga4-*) already provides the funnel/journey data,
    // so this cross-check connector stays off (skipped, not failed) until that
    // service account exists. Enable with GA4_API_ENABLED=true.
    return (
      process.env.GA4_API_ENABLED === 'true' && isGcpConfigured() && Boolean(config.ga4PropertyId)
    );
  }

  protected async extract(w: DateWindow): Promise<Ga4AggregateRow[]> {
    const token = await getAccessToken();
    const registered = await scanParamsAreRegistered();

    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${config.ga4PropertyId}:runReport`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate: w.start, endDate: w.end }],
          dimensions: [
            { name: 'date' },
            { name: 'eventName' },
            { name: 'platform' },
            { name: 'appVersion' },
            // Only when registered — otherwise the API returns empty rows.
            ...(registered.registered.includes('store_id') ? [{ name: 'customEvent:store_id' }] : []),
          ],
          metrics: [
            { name: 'eventCount' }, { name: 'sessions' }, { name: 'activeUsers' },
            { name: 'totalRevenue' }, { name: 'transactions' },
          ],
          limit: 100000,
          returnPropertyQuota: true, // §17.3 — always; log the remaining quota
        }),
      },
    );
    if (!res.ok) throw new Error(`GA4 Data API ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }>;
      propertyQuota?: Record<string, { consumed: number; remaining: number }>;
    };

    // When the API starts failing at 4pm every day, quota history is how you
    // find out why (§17.3).
    if (body.propertyQuota) {
      console.info(`[${this.id}] propertyQuota`, JSON.stringify(body.propertyQuota));
    }

    return (body.rows ?? []).map((r) => ({
      dateKey: `${r.dimensionValues[0].value.slice(0, 4)}-${r.dimensionValues[0].value.slice(4, 6)}-${r.dimensionValues[0].value.slice(6, 8)}`,
      eventName: r.dimensionValues[1]?.value ?? '',
      platform: r.dimensionValues[2]?.value ?? '',
      appVersion: r.dimensionValues[3]?.value ?? '',
      eventCount: Number(r.metricValues[0]?.value ?? 0),
      sessions: Number(r.metricValues[1]?.value ?? 0),
      activeUsers: Number(r.metricValues[2]?.value ?? 0),
      totalRevenue: Number(r.metricValues[3]?.value ?? 0),
      transactions: Number(r.metricValues[4]?.value ?? 0),
    }));
  }

  protected transform(rows: Ga4AggregateRow[]): Ga4AggregateRow[] {
    return rows;
  }

  /** Read-through only — this connector never writes to a mart BQ also owns. */
  protected async load(rows: Ga4AggregateRow[]): Promise<LoadResult> {
    return { rowsIngested: rows.length, table: '(none — cross-check only)' };
  }

  protected fixture(): Ga4AggregateRow[] {
    return [];
  }

  readonly assertions: Assertion<Ga4AggregateRow>[] = [
    rowVolume<Ga4AggregateRow>({ tolerance: 0.8, zeroIsFail: false }),
  ];
}

export const ga4Api = new Ga4ApiConnector();
