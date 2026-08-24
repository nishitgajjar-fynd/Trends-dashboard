/**
 * §23 — Connector 9: `gcp-logging`. P2.
 *
 * Backend error volume for `/app-health`.
 *
 * §23.2 — `entries.list` is slow and quota-heavy for counting. The right shape is
 * a log-based counter metric read through Cloud Monitoring, with `entries.list`
 * reserved for the drilldown when someone clicks into a spike.
 */
import { config } from '@/lib/config';
import { rowVolume } from '@/lib/assertions';
import type { DateWindow } from '@/lib/format/dates';
import { fixtureAppHealth } from '@/fixtures/business';
import { getAccessToken, isGcpConfigured } from '@/lib/gcp/auth';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

/** The Companion backend pod. */
export const LOG_FILTER = `
resource.type="k8s_container"
resource.labels.project_id="${config.gcpProjectId}"
labels."k8s-pod/app"="scne-hashira-main-srvr"
severity>=ERROR
`.trim();

export const LOG_METRIC_NAME = 'companion_backend_errors';

export interface ErrorLogDaily {
  dateKey: string;
  errorCount: number;
}

export class GcpLoggingConnector extends BaseConnector<ErrorLogDaily, ErrorLogDaily> {
  readonly id = 'gcp-logging';
  readonly displayName = 'GCP Cloud Logging — backend errors';
  readonly freshnessSlaMinutes = 60;
  readonly costTier: CostTier = 'metered';
  readonly priority = 'P2' as const;
  readonly powers = ['error_log_volume', '/app-health'];
  readonly blockedBy = '§13.2 GCP service account + Logging Viewer';

  isConfigured(): boolean {
    return isGcpConfigured();
  }

  protected async extract(w: DateWindow): Promise<ErrorLogDaily[]> {
    const token = await getAccessToken();
    // Cloud Monitoring timeSeries over the log-based counter, aligned hourly and
    // summed — far cheaper than paging entries.list.
    const url = new URL(
      `https://monitoring.googleapis.com/v3/projects/${config.gcpProjectId}/timeSeries`,
    );
    url.searchParams.set(
      'filter',
      `metric.type="logging.googleapis.com/user/${LOG_METRIC_NAME}"`,
    );
    url.searchParams.set('interval.startTime', `${w.start}T00:00:00Z`);
    url.searchParams.set('interval.endTime', `${w.end}T23:59:59Z`);
    url.searchParams.set('aggregation.alignmentPeriod', '3600s');
    url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_SUM');

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    // §23.2 — the log-based counter metric is the cheap path, but it has to be
    // created in the project first. Until it exists (404 = metric not found),
    // fall back to counting ERROR entries via the Logging API directly, which
    // only needs Logging Viewer. Slower, but it means the card is live now.
    if (res.status === 404) return this.countViaLogging(token, w);
    if (!res.ok) throw new Error(`Cloud Monitoring ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      timeSeries?: Array<{ points?: Array<{ interval: { endTime: string }; value: { int64Value?: string } }> }>;
    };

    const byDay = new Map<string, number>();
    for (const series of body.timeSeries ?? []) {
      for (const p of series.points ?? []) {
        const dateKey = p.interval.endTime.slice(0, 10);
        byDay.set(dateKey, (byDay.get(dateKey) ?? 0) + Number(p.value.int64Value ?? 0));
      }
    }
    return [...byDay.entries()].map(([dateKey, errorCount]) => ({ dateKey, errorCount }));
  }

  /** Fallback: count ERROR log entries by day via entries.list (bounded pages). */
  private async countViaLogging(token: string, w: DateWindow): Promise<ErrorLogDaily[]> {
    const filter = `${LOG_FILTER}\ntimestamp>="${w.start}T00:00:00Z"\ntimestamp<="${w.end}T23:59:59Z"`;
    const byDay = new Map<string, number>();
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await fetch('https://logging.googleapis.com/v2/entries:list', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceNames: [`projects/${config.gcpProjectId}`],
          filter,
          pageSize: 1000,
          pageToken,
        }),
      });
      if (!res.ok) throw new Error(`Cloud Logging ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { entries?: Array<{ timestamp?: string }>; nextPageToken?: string };
      for (const e of body.entries ?? []) {
        const dateKey = String(e.timestamp ?? '').slice(0, 10);
        if (dateKey) byDay.set(dateKey, (byDay.get(dateKey) ?? 0) + 1);
      }
      pageToken = body.nextPageToken;
      pages += 1;
    } while (pageToken && pages < 15); // cap ~15k entries; a floor on very noisy days
    return [...byDay.entries()].map(([dateKey, errorCount]) => ({ dateKey, errorCount }));
  }

  protected transform(rows: ErrorLogDaily[]): ErrorLogDaily[] {
    return rows;
  }

  protected async load(rows: ErrorLogDaily[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factAppHealthDaily } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_app_health_daily' };
    await db
      .insert(factAppHealthDaily)
      .values(rows.map((r) => ({ dateKey: r.dateKey, gcpErrorLogCount: r.errorCount })))
      .onConflictDoUpdate({
        target: factAppHealthDaily.dateKey,
        set: { gcpErrorLogCount: sql`excluded.gcp_error_log_count` },
      });
    return { rowsIngested: rows.length, table: 'fact_app_health_daily' };
  }

  protected fixture(w: DateWindow): ErrorLogDaily[] {
    return fixtureAppHealth(w).map((r) => ({ dateKey: r.dateKey, errorCount: r.gcpErrorLogCount }));
  }

  readonly assertions: Assertion<ErrorLogDaily>[] = [
    rowVolume<ErrorLogDaily>({ tolerance: 0.8, zeroIsFail: false }),
  ];
}

export const gcpLogging = new GcpLoggingConnector();
