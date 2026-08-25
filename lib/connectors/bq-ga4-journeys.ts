/**
 * §16.4 — Connector: `bq-ga4-journeys` (session paths, not a declared funnel).
 *
 * `bq-ga4-events` answers "how many sessions reached `begin_checkout`".
 * This one answers "what did they do before that, and what did the ones who
 * never got there do instead" — which the daily aggregate cannot, at any price,
 * because it has already thrown the sequence away.
 *
 * The whole path is materialised per session and grouped, rather than
 * reconstructed later from adjacency counts. Reconstruction means assuming step
 * 5 is independent of step 2, and a session that reached checkout from a scan
 * behaves nothing like one that reached it from search — averaging them
 * produces a funnel matching neither. ADR-005 has the argument in full.
 *
 * Cost: this is the most expensive query in the build after the catalogue
 * master, because it reads every event row rather than a pre-aggregate. It runs
 * on a longer SLA than the funnel for that reason, and `maxBytesBilled` caps it
 * like everything else — a runaway scan is a bill, not an outage.
 */
import { createHash } from 'node:crypto';
import { config } from '@/lib/config';
import { cardinality, freshness, rowVolume } from '@/lib/assertions';
import { bqSuffix, type DateWindow } from '@/lib/format/dates';
import { isBigQueryConfigured, runQuery } from '@/lib/gcp/bigquery';
import { fixtureEventNodes, fixtureJourneyRows } from '@/fixtures/journeys';
import { BaseConnector } from './base';
import { PARAM_HELPERS } from './bq-ga4-events';
import type { Assertion, CostTier, LoadResult } from './types';

const ga4Table = () => `\`${config.bqGa4Project}.${config.bqGa4Dataset}.events_*\``;

/**
 * How many sessions a path needs before it is stored on its own.
 *
 * Without a floor the mart is one row per session — GA4 tails are enormous and
 * almost every long path is unique. Everything below the floor is collapsed
 * into a single `(other)` row per day and platform rather than dropped, so the
 * session totals still reconcile against `fact_funnel_daily` and the tail is
 * visible as a quantity instead of silently missing.
 */
export const MIN_PATH_SESSIONS = 5;

/** Beyond this the sequence is noise: nobody reads an eleventh step. */
export const MAX_PATH_STEPS = 10;

export const JOURNEY_PATH_SQL = () => `
${PARAM_HELPERS}
WITH ev AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS date_key,
    CONCAT(user_pseudo_id, '-', CAST(pi(event_params, 'ga_session_id') AS STRING)) AS session_key,
    COALESCE(ps(event_params, 'platform'), device.operating_system, '') AS platform,
    event_name,
    event_timestamp,
    IFNULL(ecommerce.purchase_revenue, 0) AS revenue
  FROM ${ga4Table()}
  WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
    AND pi(event_params, 'ga_session_id') IS NOT NULL
),
-- GA4 fires the same event repeatedly within a step (scroll, view_item on a
-- carousel). Collapsing runs first keeps "scan → view → bag" from being stored
-- as "scan → view → view → view → bag", which would fragment the tree and hide
-- the shape under repetition.
ordered AS (
  SELECT *, LAG(event_name) OVER (PARTITION BY session_key ORDER BY event_timestamp) AS prev_event
  FROM ev
),
deduped AS (
  SELECT * FROM ordered WHERE prev_event IS NULL OR prev_event != event_name
),
seq AS (
  SELECT
    date_key,
    session_key,
    ANY_VALUE(platform) AS platform,
    ARRAY_AGG(event_name ORDER BY event_timestamp LIMIT ${MAX_PATH_STEPS}) AS steps,
    (MAX(event_timestamp) - MIN(event_timestamp)) / 1000000 AS seconds,
    SUM(revenue) AS revenue,
    -- Companion has no GA4 revenue field; a session converts when it fires
    -- payment_success (checked across the whole session, not just the first steps).
    LOGICAL_OR(event_name = 'payment_success') AS converted
  FROM deduped
  GROUP BY 1, 2
)
SELECT
  date_key,
  platform,
  ARRAY_TO_STRING(steps, '>') AS path,
  ARRAY_LENGTH(steps) AS step_count,
  COUNT(*) AS sessions,
  COUNTIF(converted) AS converted_sessions,
  SUM(revenue) AS revenue,
  CAST(APPROX_QUANTILES(seconds, 2)[OFFSET(1)] AS INT64) AS median_seconds
FROM seq
GROUP BY 1, 2, 3, 4
HAVING sessions >= @min_sessions
ORDER BY sessions DESC
LIMIT 20000
`.trim();

/** The tail, as one row per day and platform, so the totals still add up. */
export const JOURNEY_TAIL_SQL = () => `
${PARAM_HELPERS}
WITH ev AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS date_key,
    CONCAT(user_pseudo_id, '-', CAST(pi(event_params, 'ga_session_id') AS STRING)) AS session_key,
    COALESCE(ps(event_params, 'platform'), device.operating_system, '') AS platform,
    event_name, event_timestamp, IFNULL(ecommerce.purchase_revenue, 0) AS revenue
  FROM ${ga4Table()}
  WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
    AND pi(event_params, 'ga_session_id') IS NOT NULL
),
ordered AS (
  SELECT *, LAG(event_name) OVER (PARTITION BY session_key ORDER BY event_timestamp) AS prev_event FROM ev
),
deduped AS (SELECT * FROM ordered WHERE prev_event IS NULL OR prev_event != event_name),
seq AS (
  SELECT date_key, session_key, ANY_VALUE(platform) AS platform,
    ARRAY_TO_STRING(ARRAY_AGG(event_name ORDER BY event_timestamp LIMIT ${MAX_PATH_STEPS}), '>') AS path,
    SUM(revenue) AS revenue,
    LOGICAL_OR(event_name = 'payment_success') AS converted
  FROM deduped GROUP BY 1, 2
),
counted AS (SELECT *, COUNT(*) OVER (PARTITION BY date_key, platform, path) AS path_sessions FROM seq)
SELECT date_key, platform, '(other)' AS path, 0 AS step_count,
  COUNT(*) AS sessions, COUNTIF(converted) AS converted_sessions,
  SUM(revenue) AS revenue, CAST(NULL AS INT64) AS median_seconds
FROM counted
WHERE path_sessions < @min_sessions
GROUP BY 1, 2
`.trim();

export const EVENT_NODE_SQL = () => `
${PARAM_HELPERS}
WITH ev AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS date_key,
    CONCAT(user_pseudo_id, '-', CAST(pi(event_params, 'ga_session_id') AS STRING)) AS session_key,
    COALESCE(ps(event_params, 'platform'), device.operating_system, '') AS platform,
    event_name,
    IFNULL(ecommerce.purchase_revenue, 0) AS revenue
  FROM ${ga4Table()}
  WHERE _TABLE_SUFFIX BETWEEN @suffix_start AND @suffix_end
    AND pi(event_params, 'ga_session_id') IS NOT NULL
)
SELECT
  date_key, platform, event_name AS event,
  COUNT(DISTINCT session_key) AS sessions,
  COUNT(*) AS events,
  COUNT(DISTINCT IF(revenue > 0, session_key, NULL)) AS revenue_sessions,
  SUM(revenue) AS revenue
FROM ev
GROUP BY 1, 2, 3
`.trim();

interface RawPathRow {
  date_key: string;
  platform: string | null;
  path: string;
  step_count: number;
  sessions: number;
  converted_sessions: number;
  revenue: number | null;
  median_seconds: number | null;
}

interface RawNodeRow {
  date_key: string;
  platform: string | null;
  event: string;
  sessions: number;
  events: number;
  revenue_sessions: number;
  revenue: number | null;
}

/** Row shape as stored: paths and nodes share one connector and one run. */
export interface JourneyRow {
  kind: 'path' | 'node';
  dateKey: string;
  platform: string;
  /** '>'-joined for a path, the event name for a node. */
  key: string;
  stepCount: number;
  sessions: number;
  events: number;
  convertedSessions: number;
  revenue: number;
  medianSeconds: number | null;
}

export const pathHash = (dateKey: string, platform: string, path: string): string =>
  createHash('sha1').update(`${dateKey}|${platform}|${path}`).digest('hex').slice(0, 24);

export class BqGa4JourneysConnector extends BaseConnector<RawPathRow | RawNodeRow, JourneyRow> {
  readonly id = 'bq-ga4-journeys';
  readonly displayName = 'BigQuery — GA4 session paths';
  /** Paths follow the same daily export as the funnel, plus room for the scan. */
  readonly freshnessSlaMinutes = 52 * 60;
  readonly costTier: CostTier = 'expensive';
  readonly priority = 'P1' as const;
  readonly powers = ['/journey/discovered', 'journey findings', 'fact_journey_path', 'fact_event_node'];
  readonly blockedBy = '§13.1 GA4→BQ dataset name (unknown); §13.2 GCP service account';

  readonly assertions: Assertion<JourneyRow>[] = [
    rowVolume({ vsTrailingMedianDays: 7, tolerance: 0.4, zeroIsFail: true }),
    freshness({ column: 'dateKey', maxLagHours: 52 }),
    // A single distinct path means the sessionisation collapsed — every session
    // hashing to one key produces exactly one path with every session on it,
    // and it would otherwise render as a beautifully clean funnel.
    cardinality({ column: 'key', minDistinct: 5, level: 'fail' }),
  ];

  isConfigured(): boolean {
    return isBigQueryConfigured() && Boolean(config.bqGa4Project) && Boolean(config.bqGa4Dataset);
  }

  protected async extract(w: DateWindow): Promise<Array<RawPathRow | RawNodeRow>> {
    const params = { suffix_start: bqSuffix(w.start), suffix_end: bqSuffix(w.end), min_sessions: MIN_PATH_SESSIONS };
    const types = { suffix_start: 'STRING', suffix_end: 'STRING', min_sessions: 'INT64' } as const;

    const [paths, tail, nodes] = await Promise.all([
      runQuery<RawPathRow>({ query: JOURNEY_PATH_SQL(), params, types, connector: this.id }),
      runQuery<RawPathRow>({ query: JOURNEY_TAIL_SQL(), params, types, connector: this.id }),
      runQuery<RawNodeRow>({ query: EVENT_NODE_SQL(), params, types, connector: this.id }),
    ]);
    return [...paths.rows, ...tail.rows, ...nodes.rows];
  }

  protected transform(rows: Array<RawPathRow | RawNodeRow>): JourneyRow[] {
    return rows.map((r) => {
      if ('path' in r) {
        return {
          kind: 'path' as const,
          dateKey: r.date_key,
          platform: r.platform ?? '',
          key: r.path,
          stepCount: Number(r.step_count),
          sessions: Number(r.sessions),
          events: Number(r.sessions),
          convertedSessions: Number(r.converted_sessions),
          revenue: Number(r.revenue ?? 0),
          medianSeconds: r.median_seconds == null ? null : Number(r.median_seconds),
        };
      }
      return {
        kind: 'node' as const,
        dateKey: r.date_key,
        platform: r.platform ?? '',
        key: r.event,
        stepCount: 0,
        sessions: Number(r.sessions),
        events: Number(r.events),
        convertedSessions: Number(r.revenue_sessions),
        revenue: Number(r.revenue ?? 0),
        medianSeconds: null,
      };
    });
  }

  protected async load(rows: JourneyRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factJourneyPath, factEventNode } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_journey_path' };

    const paths = rows.filter((r) => r.kind === 'path');
    const nodes = rows.filter((r) => r.kind === 'node');

    // Deduplicate on the natural key before insert. Postgres refuses an
    // ON CONFLICT DO UPDATE that would touch one row twice in a statement, and
    // two different paths can collide on a truncated hash.
    const seenPaths = new Map<string, (typeof paths)[number]>();
    for (const p of paths) seenPaths.set(`${p.dateKey}|${p.platform}|${p.key}`, p);

    for (const chunk of batches([...seenPaths.values()], 500)) {
      await db
        .insert(factJourneyPath)
        .values(
          chunk.map((p) => ({
            dateKey: p.dateKey,
            platform: p.platform,
            pathHash: pathHash(p.dateKey, p.platform, p.key),
            path: p.key,
            stepCount: p.stepCount,
            sessions: p.sessions,
            convertedSessions: p.convertedSessions,
            revenue: String(p.revenue),
            medianSeconds: p.medianSeconds,
          })),
        )
        .onConflictDoUpdate({
          target: [factJourneyPath.dateKey, factJourneyPath.platform, factJourneyPath.pathHash],
          set: {
            path: sql`excluded.path`,
            stepCount: sql`excluded.step_count`,
            sessions: sql`excluded.sessions`,
            convertedSessions: sql`excluded.converted_sessions`,
            revenue: sql`excluded.revenue`,
            medianSeconds: sql`excluded.median_seconds`,
          },
        });
    }

    const seenNodes = new Map<string, (typeof nodes)[number]>();
    for (const n of nodes) seenNodes.set(`${n.dateKey}|${n.platform}|${n.key}`, n);

    for (const chunk of batches([...seenNodes.values()], 500)) {
      await db
        .insert(factEventNode)
        .values(
          chunk.map((n) => ({
            dateKey: n.dateKey,
            platform: n.platform,
            event: n.key,
            sessions: n.sessions,
            events: n.events,
            revenueSessions: n.convertedSessions,
            revenue: String(n.revenue),
          })),
        )
        .onConflictDoUpdate({
          target: [factEventNode.dateKey, factEventNode.platform, factEventNode.event],
          set: {
            sessions: sql`excluded.sessions`,
            events: sql`excluded.events`,
            revenueSessions: sql`excluded.revenue_sessions`,
            revenue: sql`excluded.revenue`,
          },
        });
    }

    return { rowsIngested: seenPaths.size + seenNodes.size, table: 'fact_journey_path, fact_event_node' };
  }

  protected fixture(w: DateWindow): JourneyRow[] {
    const out: JourneyRow[] = [];
    // Per day and per platform, matching the mart's key. The collapsed form
    // would land ninety days on one date and lose all but the last row of each
    // shape to the upsert.
    for (const p of fixtureJourneyRows(w)) {
      out.push({
        kind: 'path',
        dateKey: p.dateKey,
        platform: p.platform,
        key: p.steps.join('>'),
        stepCount: p.steps.length,
        sessions: p.sessions,
        events: p.sessions,
        convertedSessions: p.convertedSessions,
        revenue: p.revenue,
        medianSeconds: p.medianSeconds,
      });
    }
    for (const n of fixtureEventNodes(w)) {
      out.push({
        kind: 'node',
        dateKey: w.end,
        platform: '',
        key: n.event,
        stepCount: 0,
        sessions: n.sessions,
        events: n.events,
        convertedSessions: n.revenueSessions,
        revenue: n.revenue,
        medianSeconds: null,
      });
    }
    return out;
  }
}

function* batches<T>(rows: T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

export const bqGa4Journeys = new BqGa4JourneysConnector();
