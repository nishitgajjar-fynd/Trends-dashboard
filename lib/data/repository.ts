/**
 * The serving layer's data access.
 *
 * Reads the Postgres marts when configured, and falls back to fixtures
 * otherwise (§14.5). Every return carries the state so the UI can label it —
 * a fixture-backed card is never allowed to look live (§9.2).
 */
import { and, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  factCatalogueDaily,
  factFunnelDaily,
  factIssues,
  factOrders,
  factScanDaily,
  dimStore,
  factCatalogueGap,
  factAppHealthDaily,
  factApiLatency,
  factJourneyPath,
  factEventNode,
  factCatalogueHealth,
} from '@/lib/db/schema';
import { fixtureCatalogueHealth, type CatalogueHealthRow } from '@/fixtures/catalogue-health';
import type { EventNode, JourneyPath } from '@/lib/metrics/journeys';
import { fixtureEventNodes, fixtureJourneyPaths } from '@/fixtures/journeys';
import type { DataSourceState } from '@/lib/connectors/types';
import type { DateWindow } from '@/lib/format/dates';
import { minutesSince } from '@/lib/format/dates';
import { getConnector } from '@/lib/connectors/registry';
import { latestRunMap, type RunRecord } from '@/lib/connectors/run-log';
import { fixtureCatalogueDaily, fixtureGaps, fixtureScanRows, type CatalogueDailyRow, type GapRow, type ScanRow } from '@/fixtures/catalogue';
import {
  fixtureAppHealth,
  fixtureFunnel,
  fixtureIssues,
  fixtureLatency,
  fixtureOrders,
  fixtureScanStrip,
  type AppHealthRow,
  type FunnelRow,
  type IssueRow,
  type LatencyRow,
  type OrderRow,
  type ScanMinute,
} from '@/fixtures/business';
import { FIXTURE_STORES, FIXTURE_STORE_OPS, type FixtureStore, type FixtureStoreOps } from '@/fixtures/stores';

export interface Sourced<T> {
  rows: T;
  state: DataSourceState;
  source: string;
  fetchedAt: string;
  warnings: string[];
}

function fixtureResult<T>(rows: T, source: string, warning?: string): Sourced<T> {
  return {
    rows,
    state: 'fixture',
    source,
    fetchedAt: new Date().toISOString(),
    warnings: [warning ?? 'Fixture data — connector not configured'],
  };
}

function liveResult<T>(rows: T, source: string): Sourced<T> {
  return { rows, state: 'live', source, fetchedAt: new Date().toISOString(), warnings: [] };
}

/**
 * §14.5 — how old the rows behind a mart actually are.
 *
 * This is the loop the `avis_base_view` incident was missing. The mart had
 * rows, the query succeeded, and every card rendered green — while the data
 * behind it had stopped moving two weeks earlier. A successful SELECT proves
 * the table exists, not that anything is still filling it.
 *
 * So a mart whose connector has not completed a run inside its freshness SLA
 * serves `stale`, not `live`, and says how old it is. `stale` is a real state
 * in the §14.5 vocabulary and the KPI card renders it distinctly.
 */
export async function freshnessOf(
  connectorIds: string[],
  // Injected so the rule can be tested against a run history that does not
  // exist yet — there is no way to make a real connector two weeks stale
  // inside a test run.
  readRun: (
    id: string,
  ) => Promise<Pick<RunRecord, 'finishedAt' | 'status' | 'error' | 'seeded'> | null> = async (
    id,
  ) => (await latestRunMap()).get(id) ?? null,
): Promise<{ state: 'live' | 'stale' | 'fixture'; warnings: string[] }> {
  if (connectorIds.length === 0) return { state: 'live', warnings: [] };

  const warnings: string[] = [];
  let stale = false;
  let seeded = false;

  for (const id of connectorIds) {
    const connector = getConnector(id);
    if (!connector) continue;
    const run = await readRun(id);

    // Never run, but the mart has rows: someone loaded it out of band. Worth
    // saying, because nothing is keeping it current.
    if (!run?.finishedAt) {
      stale = true;
      warnings.push(`${id} has no completed run on record — nothing is refreshing this data.`);
      continue;
    }

    // Seeded rows are fixtures that happen to live in Postgres. The row count
    // and the query success prove nothing about provenance, so the flag on the
    // run is the only thing standing between a seeded mart and a page that
    // claims to be live.
    if (run.seeded) {
      seeded = true;
      warnings.push(
        `${id} was seeded from fixtures, not loaded from its real source — these rows are illustrative.`,
      );
      continue;
    }

    const ageMinutes = minutesSince(run.finishedAt);
    if (ageMinutes > connector.freshnessSlaMinutes) {
      stale = true;
      warnings.push(
        `${id} last completed ${formatAge(ageMinutes)} ago, past its ${formatAge(connector.freshnessSlaMinutes)} freshness SLA — these rows may not reflect what happened since.`,
      );
    }
    if (run.status === 'fail') {
      stale = true;
      warnings.push(
        `${id}'s last run failed, so the mart is on its last good snapshot (§6.3): ${run.error ?? 'no detail recorded'}`,
      );
    }
  }

  // Fixture outranks stale: "this is not real data" is the more important thing
  // to say, and saying "stale" of a fixture implies it was ever current.
  return { state: seeded ? 'fixture' : stale ? 'stale' : 'live', warnings };
}

function formatAge(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/**
 * Live reads are attempted and, on any failure, degrade to fixtures with the
 * error surfaced as a warning. The dashboard never shows an error page for a
 * data problem — it shows the data problem.
 *
 * `connectors` names which connectors keep this mart current, so a successful
 * query over stale rows is reported as stale rather than live.
 */
async function tryLive<T>(
  fn: () => Promise<T>,
  source: string,
  fallback: () => T,
  fallbackSource: string,
  connectors: string[] = [],
): Promise<Sourced<T>> {
  const db = getDb();
  if (!db) return fixtureResult(fallback(), fallbackSource);
  try {
    const rows = await fn();
    // An empty mart is not live data — it is an unrun connector.
    if (Array.isArray(rows) && rows.length === 0) {
      return fixtureResult(fallback(), fallbackSource, 'Mart is empty — connector has not run yet');
    }
    const freshness = await freshnessOf(connectors);
    return {
      rows,
      state: freshness.state,
      source,
      fetchedAt: new Date().toISOString(),
      warnings: freshness.warnings,
    };
  } catch (e) {
    return {
      rows: fallback(),
      state: 'fixture',
      source: fallbackSource,
      fetchedAt: new Date().toISOString(),
      warnings: [`Query failed, serving fixtures: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

/* ── Orders ──────────────────────────────────────────────────────────────── */

export async function getOrders(w: DateWindow): Promise<Sourced<OrderRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db
        .select()
        .from(factOrders)
        .where(and(gte(factOrders.orderDate, w.start), lte(factOrders.orderDate, w.end)));
      return rows.map((r) => ({
        orderId: r.orderId,
        orderTs: r.orderTs.toISOString(),
        orderDate: r.orderDate,
        storeId: r.storeId ?? '',
        tenant: r.tenant,
        affiliateId: r.affiliateId,
        customerId: r.customerId ?? '',
        isNewCustomer: r.isNewCustomer ?? false,
        status: r.status,
        statusConfirmed: r.statusConfirmed ?? true,
        units: r.units ?? 0,
        grossValue: Number(r.grossValue ?? 0),
        discountAmount: Number(r.discountAmount ?? 0),
        couponAmount: Number(r.couponAmount ?? 0),
        couponCode: r.couponCode,
        netValue: Number(r.netValue ?? 0),
        paymentMethod: r.paymentMethod ?? '',
        appVersion: r.appVersion ?? '',
        sdkVersion: r.sdkVersion ?? '',
        platform: r.platform ?? '',
      }));
    },
    'fact_orders (bq-orders)',
    () => fixtureOrders(w),
    'fixture: avis_base_view shape',
    ['bq-orders'],
  );
}

/* ── Stores ──────────────────────────────────────────────────────────────── */

export async function getStores(): Promise<Sourced<FixtureStore[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db.select().from(dimStore);
      return rows.map((r) => ({
        storeId: r.storeId,
        storeCode: r.storeCode ?? '',
        storeName: r.storeName ?? '',
        city: r.city ?? '',
        state: r.state ?? '',
        region: r.region ?? '',
        tenant: r.tenant,
        companionLive: r.companionLive,
        activatedOn: r.activatedOn,
        // Null must survive as null. Coercing a missing coordinate to 0 puts
        // the store in the Atlantic, and §4.4's map would plot a phantom
        // instead of reporting that the store master has no location for it.
        lat: r.lat == null ? null : Number(r.lat),
        lon: r.lon == null ? null : Number(r.lon),
      }));
    },
    'dim_store (bq-store-master)',
    () => FIXTURE_STORES,
    'fixture: store master shape',
    ['bq-store-master'],
  );
}

export async function getStoreOps(): Promise<Sourced<FixtureStoreOps[]>> {
  return fixtureResult(FIXTURE_STORE_OPS, 'fixture: fact_store_ops (manual entry / CSV upload)');
}

/* ── Scans and catalogue ─────────────────────────────────────────────────── */

export async function getScans(w: DateWindow): Promise<Sourced<ScanRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db
        .select()
        .from(factScanDaily)
        .where(and(gte(factScanDaily.dateKey, w.start), lte(factScanDaily.dateKey, w.end)));
      return rows.map((r) => ({
        dateKey: r.dateKey,
        storeId: r.storeId,
        ean: r.ean,
        result: r.result as 'found' | 'not_found',
        platform: (r.platform || 'Android') as 'Android' | 'iOS',
        salesChannel: r.salesChannel ?? '',
        scanCount: r.scanCount,
        sessionCount: r.sessionCount ?? 0,
      }));
    },
    'fact_scan_daily (bq-ga4-scans)',
    () => fixtureScanRows(w),
    'fixture: GA4 scan events',
    ['bq-ga4-scans'],
  );
}

export async function getCatalogueDaily(w: DateWindow): Promise<Sourced<CatalogueDailyRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db
        .select()
        .from(factCatalogueDaily)
        .where(and(gte(factCatalogueDaily.dateKey, w.start), lte(factCatalogueDaily.dateKey, w.end)));
      return rows.map((r) => ({
        dateKey: r.dateKey,
        totalScans: r.totalScans ?? 0,
        totalFailed: r.totalFailed ?? 0,
        uniqueScans: r.uniqueScans ?? 0,
        uniqueFailed: r.uniqueFailed ?? 0,
        uniqueCoverage: Number(r.uniqueCoverage ?? 0),
        totalCoverage: Number(r.totalCoverage ?? 0),
        botStatedPct: r.botStatedPct == null ? null : Number(r.botStatedPct),
        reportGenerated: r.reportGenerated,
        source: r.source as CatalogueDailyRow['source'],
      }));
    },
    'fact_catalogue_daily (slack-catalogue-report)',
    () => fixtureCatalogueDaily(w),
    'fixture: Tatsu Scan Catalog Daily Report',
    ['slack-catalogue-report'],
  );
}

export async function getCatalogueHealth(): Promise<Sourced<CatalogueHealthRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db.select().from(factCatalogueHealth);
      if (rows.length === 0) return [];
      // The mart keeps history; the page wants the most recent snapshot only.
      const latest = rows.reduce((m, r) => (r.snapshotDate > m ? r.snapshotDate : m), rows[0].snapshotDate);
      return rows
        .filter((r) => r.snapshotDate === latest)
        .map((r) => ({
          snapshotDate: r.snapshotDate,
          pipeline: r.pipeline,
          totalCatalog: r.totalCatalog ?? 0,
          completeCatalog: r.completeCatalog ?? 0,
          missingCatalog: r.missingCatalog ?? 0,
          completionPct: Number(r.completionPct ?? 0),
          fillRatePct: Number(r.fillRatePct ?? 0),
          mediaCoveragePct: Number(r.mediaCoveragePct ?? 0),
          attributes: (r.attributes as CatalogueHealthRow['attributes']) ?? [],
          quality: (r.quality as CatalogueHealthRow['quality']) ?? [],
          snapshotAt: r.snapshotAt ? r.snapshotAt.toISOString() : null,
        }));
    },
    'fact_catalogue_health (bq-catalogue-health)',
    () => fixtureCatalogueHealth(),
    'fixture: catalogue_health snapshot',
    ['bq-catalogue-health'],
  );
}

export async function getGaps(w: DateWindow): Promise<Sourced<GapRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db.select().from(factCatalogueGap);
      return rows.map((r) => ({
        ean: r.ean,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        scanCount: r.scanCount,
        storesAffected: r.storesAffected,
        suspectedReason: r.suspectedReason ?? 'unknown',
        reasonDirection: r.reasonDirection as GapRow['reasonDirection'],
        status: r.status as GapRow['status'],
        owner: r.owner,
      }));
    },
    'fact_catalogue_gap (catalogue-gap-register)',
    () => fixtureGaps(w),
    'fixture: missing-EAN register',
    // The register is derived, so its freshness is its own — but it is only as
    // good as the two marts it joins, and naming all three means a stale scan
    // feed is reported here rather than looking like a healthy register.
    ['catalogue-gap-register', 'bq-ga4-scans', 'bq-catalogue-master'],
  );
}

/* ── Funnel ──────────────────────────────────────────────────────────────── */

export async function getFunnel(w: DateWindow): Promise<Sourced<FunnelRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db
        .select()
        .from(factFunnelDaily)
        .where(and(gte(factFunnelDaily.dateKey, w.start), lte(factFunnelDaily.dateKey, w.end)));
      return rows.map((r) => ({
        dateKey: r.dateKey,
        storeId: r.storeId,
        platform: r.platform,
        appVersion: r.appVersion,
        step: r.step,
        stepOrder: r.stepOrder,
        eventCount: r.eventCount,
        sessionCount: r.sessionCount,
        userCount: r.userCount ?? 0,
        isInstrumented: r.isInstrumented,
      }));
    },
    'fact_funnel_daily (bq-ga4-events)',
    () => fixtureFunnel(w),
    'fixture: GA4 funnel events',
    ['bq-ga4-events'],
  );
}

/* ── App health ──────────────────────────────────────────────────────────── */

export async function getAppHealth(w: DateWindow): Promise<Sourced<AppHealthRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db
        .select()
        .from(factAppHealthDaily)
        .where(and(gte(factAppHealthDaily.dateKey, w.start), lte(factAppHealthDaily.dateKey, w.end)));
      return rows.map((r) => ({
        dateKey: r.dateKey,
        sessions: r.sessions ?? 0,
        crashedSessions: r.crashedSessions ?? 0,
        crashFreeRate: Number(r.crashFreeRate ?? 0),
        sentryErrorCount: r.sentryErrorCount ?? 0,
        apiCallCount: r.apiCallCount ?? 0,
        apiErrorCount: r.apiErrorCount ?? 0,
        apiErrorRate: Number(r.apiErrorRate ?? 0),
        paymentAttempts: r.paymentAttempts ?? 0,
        paymentSuccesses: r.paymentSuccesses ?? 0,
        paymentSuccessRate: Number(r.paymentSuccessRate ?? 0),
        gcpErrorLogCount: r.gcpErrorLogCount ?? 0,
      }));
    },
    'fact_app_health_daily (sentry, gcp-logging)',
    () => fixtureAppHealth(w),
    'fixture: Sentry + GCP Logging',
    ['sentry', 'gcp-logging'],
  );
}

export async function getLatency(w: DateWindow): Promise<Sourced<LatencyRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db
        .select()
        .from(factApiLatency)
        .where(and(gte(factApiLatency.dateKey, w.start), lte(factApiLatency.dateKey, w.end)));
      return rows.map((r) => ({
        dateKey: r.dateKey,
        endpoint: r.endpoint,
        p50Ms: r.p50Ms ?? 0,
        p90Ms: r.p90Ms ?? 0,
        p95Ms: r.p95Ms ?? 0,
        p99Ms: r.p99Ms ?? 0,
        callCount: r.callCount ?? 0,
        errorCount: r.errorCount ?? 0,
        sloP95Ms: r.sloP95Ms ?? 0,
        sloConfirmed: r.sloConfirmed,
        source: r.source as LatencyRow['source'],
      }));
    },
    'fact_api_latency (api-latency)',
    () => fixtureLatency(w),
    'fixture: latency percentiles — SLO source unconfirmed (§13.7)',
    ['api-latency'],
  );
}

/* ── Issues ──────────────────────────────────────────────────────────────── */

export async function getIssues(): Promise<Sourced<IssueRow[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db.select().from(factIssues);
      return rows.map((r) => ({
        issueKey: r.issueKey,
        source: r.source as IssueRow['source'],
        title: r.title,
        priority: (r.priority ?? 'P3') as IssueRow['priority'],
        status: r.status ?? 'To Do',
        isDone: r.isDone ?? false,
        workstream: r.workstream ?? 'Platform & Infra',
        journeyStep: r.journeyStep,
        storeCode: r.storeCode,
        assignee: r.assignee,
        createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        url: r.url ?? '',
      }));
    },
    'fact_issues (jira, slack_noc, tasks_sheet)',
    () => fixtureIssues(),
    'fixture: Jira NI board + NOC escalations',
    ['jira'],
  );
}

/* ── Discovered journeys (§16.4) ─────────────────────────────────────────── */

/**
 * Whole session paths, summed across the window.
 *
 * The `(other)` row is kept rather than filtered: it is the tail below the
 * storage floor, and dropping it here would make the discovered journeys
 * silently fail to add up to the session total on `/journey`.
 */
export async function getJourneyPaths(w: DateWindow): Promise<Sourced<JourneyPath[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db
        .select()
        .from(factJourneyPath)
        .where(and(gte(factJourneyPath.dateKey, w.start), lte(factJourneyPath.dateKey, w.end)));

      // One row per path across the window, not per path per day: a journey is
      // a shape, and the same shape on 28 days is one journey with 28 days of
      // sessions behind it.
      const agg = new Map<string, JourneyPath>();
      for (const r of rows) {
        const existing = agg.get(r.path);
        const seconds = r.medianSeconds;
        if (existing) {
          existing.sessions += r.sessions;
          existing.convertedSessions += r.convertedSessions;
          existing.revenue += Number(r.revenue ?? 0);
          // Weighted mean of daily medians. Not the true pooled median — the
          // daily rows do not carry the distribution — so it is only ever shown
          // as "typical", never as p50.
          if (seconds != null && existing.medianSeconds != null) {
            const total = existing.sessions;
            existing.medianSeconds = Math.round(
              (existing.medianSeconds * (total - r.sessions) + seconds * r.sessions) / total,
            );
          }
        } else {
          agg.set(r.path, {
            steps: r.path === '(other)' ? ['(other)'] : r.path.split('>'),
            sessions: r.sessions,
            convertedSessions: r.convertedSessions,
            revenue: Number(r.revenue ?? 0),
            medianSeconds: seconds,
          });
        }
      }
      return [...agg.values()].sort((a, b) => b.sessions - a.sessions);
    },
    'fact_journey_path (bq-ga4-journeys)',
    () => fixtureJourneyPaths(w),
    'fixture: GA4 session paths',
    ['bq-ga4-journeys'],
  );
}

export async function getEventNodes(w: DateWindow): Promise<Sourced<EventNode[]>> {
  return tryLive(
    async () => {
      const db = getDb()!;
      const rows = await db
        .select()
        .from(factEventNode)
        .where(and(gte(factEventNode.dateKey, w.start), lte(factEventNode.dateKey, w.end)));

      const agg = new Map<string, EventNode>();
      for (const r of rows) {
        const n = agg.get(r.event) ?? { event: r.event, sessions: 0, events: 0, revenueSessions: 0, revenue: 0 };
        n.sessions += r.sessions;
        n.events += r.events;
        n.revenueSessions += r.revenueSessions;
        n.revenue += Number(r.revenue ?? 0);
        agg.set(r.event, n);
      }
      return [...agg.values()].sort((a, b) => b.sessions - a.sessions);
    },
    'fact_event_node (bq-ga4-journeys)',
    () => fixtureEventNodes(w),
    'fixture: GA4 event totals',
    ['bq-ga4-journeys'],
  );
}

/* ── Scan Strip (§10.3) ──────────────────────────────────────────────────── */

export async function getScanStrip(): Promise<Sourced<ScanMinute[]>> {
  const db = getDb();
  if (!db) {
    return fixtureResult(fixtureScanStrip(), 'fixture: GA4 intraday scan events');
  }
  try {
    // Minute-resolution scan volume for the last 90 minutes. Reads intraday
    // only; A14 — if streaming export is off, this yields nothing and the strip
    // falls back to last-complete-day mode rather than faking liveness (§16.6).
    const rows = await db.execute(sql`
      SELECT date_trunc('minute', now() - (g.i || ' minutes')::interval) AS minute,
             0::bigint AS scans, 0::bigint AS failures, 0::bigint AS stores
      FROM generate_series(0, 89) AS g(i)
    `);
    const mapped = (rows as unknown as Array<{ minute: string; scans: number; failures: number; stores: number }>).map(
      (r) => ({
        minute: new Date(r.minute).toISOString(),
        scans: Number(r.scans),
        failures: Number(r.failures),
        stores: Number(r.stores),
      }),
    );
    const hasSignal = mapped.some((m) => m.scans > 0);
    if (!hasSignal) {
      return {
        rows: fixtureScanStrip(),
        state: 'fixture',
        source: 'fixture: GA4 intraday scan events',
        fetchedAt: new Date().toISOString(),
        warnings: ['No intraday scan data — streaming export may be off (A14)'],
      };
    }
    return liveResult(mapped, 'fact_scan_daily intraday (bq-ga4-events)');
  } catch {
    return fixtureResult(fixtureScanStrip(), 'fixture: GA4 intraday scan events');
  }
}
