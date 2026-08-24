/**
 * §14.5 — fixture session paths.
 *
 * Every number here is derived from something already documented rather than
 * invented to look plausible: the spine follows the step ratios in
 * `FUNNEL_STEPS`, which were themselves taken from the §1 baselines, and the
 * session volume follows `BASE_SESSIONS_PER_DAY` in `fixtures/business.ts`.
 * A journey view built on numbers with no provenance would be worse than an
 * empty one — it would be an empty one that nobody knew to distrust.
 *
 * The branches are the part `FUNNEL_STEPS` cannot express, and they are the
 * reason this fixture exists at all: a declared funnel has one path, so a
 * fixture built only from it would make the discovery engine look like it
 * works while never exercising the branching that is its whole point. The
 * branch shapes below are the ones the §16 event dictionary and the Slack
 * catalogue reports describe — a failed scan leading to a manual search, and
 * an abandon at the bag — with their weights marked as assumptions.
 *
 * §14.5 applies: anything served from here carries a visible fixture marker,
 * and `_source` says so.
 */
import { dateRange, type DateWindow } from '@/lib/format/dates';
import { FUNNEL_STEPS } from './business';
import { hashSeed, makeRng } from './rng';
import type { EventNode, JourneyPath } from '@/lib/metrics/journeys';

const PLATFORMS = ['Android', 'iOS'] as const;

/** Sessions per day, matching `fixtures/business.ts`. */
const BASE_SESSIONS_PER_DAY = 1700;

/**
 * The spine, read straight off `FUNNEL_STEPS`, minus the step §16.9 records as
 * never instrumented — including it here would manufacture data for the one
 * step the dashboard is supposed to report as invisible (A6).
 */
const SPINE = FUNNEL_STEPS.filter((s) => s.instrumented && !s.hidden).map((s) => ({ event: s.step, ratio: s.ratio }));

/**
 * Branch shapes. `share` is the fraction of sessions *reaching the branch
 * point* that divert. These are assumptions, flagged as such in ADR-005 —
 * they shape the fixture only and are never published as findings.
 */
const BRANCHES: Array<{ after: string; share: number; steps: string[] }> = [
  // The failed-scan recovery loop. §18 shows ~6% of scans not found, and the
  // catalogue reports describe staff falling back to manual search.
  { after: 'scan_attempt', share: 0.06, steps: ['scan_failed', 'search', 'view_item', 'add_to_cart', 'view_cart'] },
  // Browse without the scanner at all — the path a declared scan funnel makes
  // invisible, because it never reaches step 2.
  { after: 'session_start', share: 0.18, steps: ['search', 'view_item_list', 'view_item'] },
  // Abandon at the bag, the largest single loss in the §1 baselines.
  { after: 'view_cart', share: 0.28, steps: [] },
];

/**
 * A fixture path with the grain the mart actually stores.
 *
 * `fixtureJourneyPaths` below collapses these to one row per shape, which is
 * what the discovery engine wants. The connector's `fixture()` needs the
 * uncollapsed form: writing the collapsed one would put ninety days and two
 * platforms on a single date key, and since the mart is keyed on
 * (date, platform, path) the upsert would keep only the last row for each
 * shape and silently discard almost all of the sessions. That is exactly what
 * happened on the first seed — 31 rows for what should have been thousands.
 */
export interface FixtureJourneyRow extends JourneyPath {
  dateKey: string;
  platform: string;
}

export function fixtureJourneyRows(window: DateWindow): FixtureJourneyRow[] {
  const out: FixtureJourneyRow[] = [];

  for (const dateKey of dateRange(window)) {
    for (const platform of PLATFORMS) {
      const rng = makeRng(hashSeed(`journey:${dateKey}:${platform}`));
      const share = platform === 'Android' ? 0.72 : 0.28;
      const daySessions = Math.round(BASE_SESSIONS_PER_DAY * share * (0.9 + rng() * 0.2));

      // The spine, as one path per depth reached: a session that gets to step 4
      // and stops is its own distinct path, which is what the real extraction
      // produces and what makes the prefix tree exact.
      let reaching = daySessions;
      const spineCounts: number[] = [];
      for (const [i, step] of SPINE.entries()) {
        reaching = i === 0 ? reaching : Math.round(reaching * step.ratio * (0.95 + rng() * 0.1));
        spineCounts.push(reaching);
      }

      const emit = (steps: string[], sessions: number, converted: number, revenue: number, seconds: number) => {
        if (sessions <= 0 || steps.length === 0) return;
        out.push({ dateKey, platform, steps, sessions, convertedSessions: converted, revenue, medianSeconds: seconds });
      };

      for (let depth = 1; depth <= SPINE.length; depth++) {
        const here = spineCounts[depth - 1];
        const next = depth < SPINE.length ? spineCounts[depth] : 0;
        const stoppedHere = Math.max(0, here - next);
        const steps = SPINE.slice(0, depth).map((s) => s.event);
        const isPurchase = steps[steps.length - 1] === 'purchase';
        // Revenue only on the paths that end at the revenue event, so the
        // outcome detection in `journeys.ts` has something real to read.
        const revenue = isPurchase ? Math.round(stoppedHere * (395 * 2.24)) : 0;
        emit(steps, stoppedHere, isPurchase ? stoppedHere : 0, revenue, 40 * depth + Math.round(rng() * 25));
      }

      for (const branch of BRANCHES) {
        const atIdx = SPINE.findIndex((s) => s.event === branch.after);
        if (atIdx < 0 || branch.steps.length === 0) continue;
        const prefix = SPINE.slice(0, atIdx + 1).map((s) => s.event);
        let count = Math.round(spineCounts[atIdx] * branch.share);
        for (let d = 1; d <= branch.steps.length; d++) {
          const decay = 0.72 + rng() * 0.14;
          const next = d < branch.steps.length ? Math.round(count * decay) : 0;
          emit(
            [...prefix, ...branch.steps.slice(0, d)],
            Math.max(0, count - next),
            0,
            0,
            40 * (prefix.length + d) + Math.round(rng() * 30),
          );
          count = next;
        }
      }
    }
  }

  return out;
}

/**
 * One row per distinct shape, summed across the window — the form the
 * discovery engine and the repository's fixture fallback both want.
 */
export function fixtureJourneyPaths(window: DateWindow): JourneyPath[] {
  const agg = new Map<string, JourneyPath>();
  for (const r of fixtureJourneyRows(window)) {
    const key = r.steps.join('>');
    const existing = agg.get(key);
    if (existing) {
      existing.sessions += r.sessions;
      existing.convertedSessions += r.convertedSessions;
      existing.revenue += r.revenue;
    } else {
      agg.set(key, {
        steps: r.steps,
        sessions: r.sessions,
        convertedSessions: r.convertedSessions,
        revenue: r.revenue,
        medianSeconds: r.medianSeconds,
      });
    }
  }
  return [...agg.values()].sort((a, b) => b.sessions - a.sessions);
}

/** Node totals implied by the paths, so the two fixtures cannot disagree. */
export function fixtureEventNodes(window: DateWindow): EventNode[] {
  const agg = new Map<string, EventNode>();
  for (const p of fixtureJourneyPaths(window)) {
    for (const [i, event] of p.steps.entries()) {
      const n = agg.get(event) ?? { event, sessions: 0, events: 0, revenueSessions: 0, revenue: 0 };
      n.sessions += p.sessions;
      n.events += p.sessions;
      // Revenue is attributed to the terminal event only — the same event the
      // discovery engine will read to decide what counts as an outcome.
      if (i === p.steps.length - 1) {
        n.revenueSessions += p.convertedSessions;
        n.revenue += p.revenue;
      }
      agg.set(event, n);
    }
  }
  return [...agg.values()].sort((a, b) => b.sessions - a.sessions);
}
