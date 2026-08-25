/**
 * §6.4 — what to run, and when.
 *
 * The naive design is one cron entry per connector. It does not survive
 * contact: Vercel's Hobby plan allows two cron entries in total, a fourteenth
 * connector means editing `vercel.json` and redeploying, and a schedule written
 * in cron syntax drifts away from the freshness SLA declared on the connector
 * until the two disagree and nobody notices which one is the truth.
 *
 * So there is **one heartbeat**, and this decides what is due. The SLA on the
 * connector is the only schedule; a connector is due when it has gone longer
 * than its SLA since the last successful run. That means the `/connectors` page
 * and the scheduler can never disagree — they read the same number.
 *
 * Two things this deliberately does not do:
 *
 *  - It does not run everything on every tick. Several connectors are metered
 *    (`bq-*` scan real bytes), and a heartbeat that re-scans BigQuery every
 *    five minutes is a bill, not a refresh.
 *  - It does not run a connector that is already running. A double-write to the
 *    mart mid-window is the one failure the assertion gate cannot catch,
 *    because both writers are producing valid rows.
 */
import { minutesSince, trailingWindow, type DateWindow } from '@/lib/format/dates';
import { CONNECTORS, getConnector } from './registry';
import { lastRunFor, isRunning } from './run-log';
import { applyStoredSources } from '@/lib/credentials/apply';

/**
 * §6.4 — how much history each run re-covers.
 *
 * Wider than the cadence on purpose. Late-arriving rows are the norm, not the
 * exception: GA4's daily export is finalised up to two days after the fact, and
 * an order placed at 23:58 IST lands in tomorrow's extract. A window that only
 * covers "since the last run" loses those rows permanently, because nothing
 * ever looks at that date again.
 */
export const WINDOW_DAYS: Record<string, number> = {
  'bq-orders': 2, // 60-min incremental covering today and yesterday (§15.7)
  'bq-ga4-events': 3,
  // Session paths follow the same daily export, with one extra day of overlap:
  // a late-landing partition would otherwise leave a hole in the prefix tree,
  // and a hole in a tree is a journey that silently stops existing.
  'bq-ga4-journeys': 4, // GA4 finalises daily tables up to 48h late
  'bq-ga4-scans': 3, // same export, same lateness
  // Wider than its inputs on purpose: the register carries an aging clock, and
  // a narrow window would drop any gap that happened not to be scanned in the
  // last three days — which is exactly the 30-day-old miss it exists to surface.
  'catalogue-gap-register': 30,
  'slack-catalogue-report': 3,
  'slack-catalogue-sync-report': 3, // hourly report; 3 days of re-cover for late edits
  'sheets-store-master': 1,
  'bq-catalogue-master': 1,
  'bq-catalogue-health': 2, // Geckoboard summary snapshot; ≥ its 26h freshness SLA.
  'bq-loyalty': 2,
  sentry: 7,
  jira: 1,
  'ga4-api': 2,
  'api-latency': 2,
  'gcp-logging': 2,
  'slack-alerts': 2,
  amplitude: 2,
  'test-ean-canary': 14,
};

/**
 * Connectors that snapshot a whole dimension rather than a slice of facts.
 *
 * A store master or a catalogue master has no window — each run replaces the
 * dimension in full. Their `WINDOW_DAYS` of 1 is a formality to satisfy the
 * lifecycle signature, not a claim about coverage, so the rule that a re-run
 * window must span at least one SLA period does not apply to them.
 */
export const SNAPSHOT_CONNECTORS = new Set(['sheets-store-master', 'bq-catalogue-master']);

export function windowFor(id: string, start?: string | null, end?: string | null): DateWindow {
  if (start && end) return { start, end };
  return trailingWindow(WINDOW_DAYS[id] ?? 2);
}

export type SkipReason = 'not_configured' | 'already_running' | 'not_due';

export interface DueVerdict {
  id: string;
  due: boolean;
  /** Minutes since the last completed run, or null if it has never run. */
  ageMinutes: number | null;
  slaMinutes: number;
  reason: SkipReason | 'never_run' | 'sla_exceeded' | 'forced';
}

/**
 * A connector that has never run is always due — that is the first run, and
 * waiting an SLA period before the first one leaves the dashboard on fixtures
 * for an hour after deploy for no reason.
 *
 * A connector whose last run *failed* is also due: the assertion gate left the
 * mart on its last good snapshot, and the next tick is exactly when to retry.
 */
export async function isDue(id: string, opts: { force?: boolean } = {}): Promise<DueVerdict> {
  const connector = getConnector(id);
  const slaMinutes = connector?.freshnessSlaMinutes ?? Infinity;

  if (!connector) return { id, due: false, ageMinutes: null, slaMinutes, reason: 'not_due' };

  if (await isRunning(id)) {
    return { id, due: false, ageMinutes: null, slaMinutes, reason: 'already_running' };
  }

  if (opts.force) return { id, due: true, ageMinutes: null, slaMinutes, reason: 'forced' };

  // Unconfigured connectors are not failures — they are known §13 blockers, and
  // running them just to watch them fall back to fixtures burns a tick and
  // fills the run log with noise that hides the real failures.
  if (!connector.isConfigured()) {
    return { id, due: false, ageMinutes: null, slaMinutes, reason: 'not_configured' };
  }

  const run = await lastRunFor(id);
  const finishedAt = run?.finishedAt ?? null;
  if (!finishedAt) return { id, due: true, ageMinutes: null, slaMinutes, reason: 'never_run' };

  const ageMinutes = minutesSince(finishedAt);
  // A fraction under the SLA, so a heartbeat that lands a few seconds early does
  // not push the connector a whole tick past its deadline every single cycle.
  const due = ageMinutes >= slaMinutes * 0.9;
  return { id, due, ageMinutes, slaMinutes, reason: due ? 'sla_exceeded' : 'not_due' };
}

export interface TickResult {
  ran: Array<{ id: string; ok: boolean; rows: number; source: string; warnings: string[]; ms: number }>;
  skipped: DueVerdict[];
  startedAt: string;
  durationMs: number;
  /** True when the budget stopped the tick early — the rest run next heartbeat. */
  truncated: boolean;
}

export interface TickOptions {
  /** Restrict to these ids. Empty means every registered connector. */
  only?: string[];
  /** Run regardless of the SLA — the manual re-run button. */
  force?: boolean;
  /**
   * Wall-clock budget. A serverless invocation is killed at its own limit with
   * no chance to write the run log, which leaves rows stuck at `running` and
   * blocks the next tick. Stopping ourselves first keeps the log honest.
   */
  budgetMs?: number;
  window?: DateWindow;
}

const DEFAULT_BUDGET_MS = 240_000; // 4 min, inside the route's maxDuration of 300s

/**
 * Runs everything that is due, sequentially.
 *
 * Sequential rather than parallel because several connectors share one GCP
 * quota and one Slack rate-limit bucket (§14.3); running them together
 * converts a slow refresh into a 429 storm and a red board.
 */
export async function tick(opts: TickOptions = {}): Promise<TickResult> {
  // §9.5 — credentials configured in the UI are projected onto the environment
  // before anything runs, so every connector keeps reading env exactly as it
  // always has and none of them needs to know the sources page exists.
  await applyStoredSources().catch(() => []);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;

  const targets = opts.only?.length
    ? CONNECTORS.filter((c) => opts.only!.includes(c.id))
    : CONNECTORS;

  const ran: TickResult['ran'] = [];
  const skipped: DueVerdict[] = [];
  let truncated = false;

  for (const c of targets) {
    if (Date.now() - t0 >= budget) {
      truncated = true;
      // Everything left is reported as not-yet-run rather than silently
      // dropped, so the next tick has a record of why.
      skipped.push({ id: c.id, due: true, ageMinutes: null, slaMinutes: c.freshnessSlaMinutes, reason: 'not_due' });
      continue;
    }

    const verdict = await isDue(c.id, { force: opts.force });
    if (!verdict.due) {
      skipped.push(verdict);
      continue;
    }

    const runStart = Date.now();
    const result = await c.run(opts.window ?? windowFor(c.id));
    ran.push({
      id: c.id,
      ok: result.ok,
      rows: result.meta.rowCount,
      source: result.meta.source,
      warnings: result.meta.warnings,
      ms: Date.now() - runStart,
    });
  }

  return { ran, skipped, startedAt, durationMs: Date.now() - t0, truncated };
}
