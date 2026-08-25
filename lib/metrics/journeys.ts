/**
 * §5 / §16.4 — journey discovery.
 *
 * The funnel this dashboard shipped with is a **declared** one: eleven steps in
 * `FUNNEL_STEPS`, written by hand, and every number on `/journey` is measured
 * against that declaration. That is the right way to track a funnel you have
 * already agreed on, and the wrong way to find out what people actually do. If
 * a third of sessions take a path nobody wrote down, the declared funnel cannot
 * show it — those sessions just quietly fail to appear at step 2.
 *
 * What follows discovers journeys from the data instead. Nobody picks the
 * steps.
 *
 * ## Exact, not modelled
 *
 * The obvious way to do this is a first-order Markov walk over an adjacency
 * table: multiply edge probabilities and call the product a path. It is wrong
 * in a way that looks right — it assumes step 5 does not depend on step 2, when
 * the whole point of a journey is that it does. A user who arrived at checkout
 * from a scan behaves differently from one who arrived from search, and the
 * Markov estimate averages them into a number matching neither.
 *
 * So the session paths are materialised whole in BigQuery (`fact_journey_path`,
 * one row per distinct ordered event sequence with its exact session count) and
 * everything here is arithmetic over a prefix tree of those rows. Every session
 * count below is a count, not an estimate.
 *
 * ## What "outcome" means
 *
 * A journey "converts" if it ends on an event that **carried revenue** in this
 * window — read from `fact_event_node.revenue_sessions`, which comes from GA4's
 * own `ecommerce.purchase_revenue`. It is deliberately not a hardcoded list of
 * event names: naming `purchase` here would be picking the answer again, and
 * would silently exclude a second checkout flow under a different event name.
 */

export const START = '(start)';

export interface EventNode {
  event: string;
  sessions: number;
  events: number;
  /** Sessions in which this event carried revenue. Defines "outcome". */
  revenueSessions: number;
  revenue: number;
}

export interface JourneyPath {
  /** Ordered, consecutive duplicates already collapsed. Does not include START. */
  steps: string[];
  sessions: number;
  /** Sessions on this exact path that carried revenue. */
  convertedSessions: number;
  revenue: number;
  /** Median seconds from first to last step, where the export carried timestamps. */
  medianSeconds: number | null;
}

export interface JourneyStep {
  event: string;
  label: string;
  /** Exact sessions whose path begins with this journey's first N steps. */
  sessions: number;
  /** Share of the previous step that reached here. `null` on the first step. */
  retention: number | null;
  /**
   * Sessions that reached the previous step and did nothing at all afterwards.
   *
   * Kept apart from `diverted` because conflating them produces a confident
   * lie. On the first pass this module reported "85% drop at Search" for a
   * journey whose sessions had simply taken the scanner instead — they were
   * still in the app, still converting, and counted as lost. An exit is a hole;
   * a diversion is a fork.
   */
  exited: number;
  /** Sessions that reached the previous step and went somewhere else instead. */
  diverted: number;
  /** Where those went, biggest first. Empty when nothing else was taken. */
  divertedTo: Array<{ event: string; label: string; sessions: number }>;
  /**
   * True for the steps this journey shares with its siblings — everything
   * before the fork that made it a distinct journey. Shown for context and
   * excluded from the journey's own drop-off accounting.
   */
  shared: boolean;
}

export interface DiscoveredJourney {
  /** Stable across runs for the same step sequence, so it can be linked to. */
  id: string;
  label: string;
  steps: JourneyStep[];
  /**
   * Sessions at the step where this journey became distinct — the fork, not the
   * app's front door. Two journeys sharing `session_start` both entered from
   * it, so measuring either against it would make them look identical and
   * make every fork look like a catastrophic drop.
   */
  entrySessions: number;
  completedSessions: number;
  /** End-to-end, of the sessions that entered at the fork. */
  conversion: number;
  outcome: 'converts' | 'abandons';
  /**
   * Index of the first step this journey owns exclusively. Steps before it are
   * shared with the sibling journeys that forked at the same place.
   */
  forkAt: number;
  /** The step where the most sessions leave outright. `null` for a one-step path. */
  worstStep: { event: string; label: string; exited: number; retention: number } | null;
  /**
   * Sessions that left the app at the worst step. The ranking key, because
   * "where is the biggest hole" is the question a journey view is opened to
   * answer — not "which journey is most popular", which flatters the happy
   * path, and not "where do the most sessions stop following this exact
   * sequence", which counts a fork as a failure.
   */
  impact: number;
  /**
   * Revenue those lost sessions would have produced at the rate this journey's
   * completers actually converted at. `null` when no completer carried revenue,
   * because a made-up rate is worse than an absent one.
   */
  revenueAtRisk: number | null;
  /** Share of all sessions in the window that entered this journey. */
  shareOfSessions: number;
}

/* ── event labels ────────────────────────────────────────────────────────── */

/**
 * `add_to_cart` → "Added to bag".
 *
 * Only cosmetic: nothing branches on a label, so an event this does not know
 * degrades to a readable Title Case rather than to a wrong step.
 */
const KNOWN_LABELS: Record<string, string> = {
  session_start: 'Session start',
  first_open: 'First open',
  scanner_open: 'Scanner opened',
  scan_attempt: 'Scan attempted',
  scan_success: 'Scan succeeded',
  scan_failed: 'Scan failed',
  view_item: 'Product viewed',
  view_item_list: 'List viewed',
  add_to_cart: 'Added to bag',
  remove_from_cart: 'Removed from bag',
  view_cart: 'Bag viewed',
  begin_checkout: 'Checkout begun',
  add_payment_info: 'Payment info added',
  add_shipping_info: 'Delivery info added',
  purchase: 'Purchase',
  refund: 'Refund',
  invoice_detag: 'Invoice / de-tag',
  search: 'Search',
  login: 'Login',
  sign_up: 'Sign-up',
  app_exception: 'Crash',
};

export function eventLabel(event: string): string {
  if (event === START) return 'Session start';
  return (
    KNOWN_LABELS[event] ??
    event.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  );
}

/* ── the prefix tree ─────────────────────────────────────────────────────── */

interface TreeNode {
  event: string;
  sessions: number;
  converted: number;
  revenue: number;
  children: Map<string, TreeNode>;
}

function buildTree(paths: JourneyPath[]): TreeNode {
  const root: TreeNode = { event: START, sessions: 0, converted: 0, revenue: 0, children: new Map() };
  for (const p of paths) {
    root.sessions += p.sessions;
    root.converted += p.convertedSessions;
    root.revenue += p.revenue;
    let node = root;
    for (const step of p.steps) {
      let child = node.children.get(step);
      if (!child) {
        child = { event: step, sessions: 0, converted: 0, revenue: 0, children: new Map() };
        node.children.set(step, child);
      }
      // Every path passing through this prefix counts here, which is what makes
      // the step totals exact rather than a product of edge probabilities.
      child.sessions += p.sessions;
      child.converted += p.convertedSessions;
      child.revenue += p.revenue;
      node = child;
    }
  }
  return root;
}

export interface DiscoverOptions {
  /** How many journeys to return. */
  limit?: number;
  /**
   * A sibling becomes its own journey when it holds at least this share of the
   * **heaviest sibling** — not of the parent.
   *
   * Measuring against the parent looks more natural and is wrong: most of a
   * parent's sessions simply end there, so the parent's count is dominated by
   * exits and every fork looks small against it. On the fixture, a genuine fork
   * taking half as many sessions as the main route scored 0.18 of its parent
   * and was discarded — the branching this whole module exists to find,
   * suppressed by people leaving. Comparing siblings compares like with like.
   */
  branchThreshold?: number;
  /** Stop extending a journey below this share of its own entry volume. */
  tailThreshold?: number;
  maxDepth?: number;
}

/**
 * Walks the tree and returns the sequences people actually take.
 *
 * A journey is extended along its heaviest child. Where a second child also
 * holds `branchThreshold` of the parent, the walk forks and both become
 * journeys — that fork is exactly the thing a declared funnel cannot express,
 * and it is usually where the interesting answer is.
 */
export function discoverJourneys(
  paths: JourneyPath[],
  nodes: EventNode[],
  opts: DiscoverOptions = {},
): DiscoveredJourney[] {
  const limit = opts.limit ?? 6;
  const branchThreshold = opts.branchThreshold ?? 0.25;
  const tailThreshold = opts.tailThreshold ?? 0.02;
  const maxDepth = opts.maxDepth ?? 10;

  if (paths.length === 0) return [];

  const root = buildTree(paths);
  const totalSessions = root.sessions;
  if (totalSessions === 0) return [];

  // Outcome is read off the data, not off a list of event names.
  const revenueEvents = new Set(nodes.filter((n) => n.revenueSessions > 0).map((n) => n.event));

  /** `forkAt` is the index in the sequence where this journey stopped being the main one. */
  const sequences: Array<{ seq: TreeNode[]; forkAt: number }> = [];

  const walk = (node: TreeNode, trail: TreeNode[], forkAt: number) => {
    const next = [...node.children.values()].sort((a, b) => b.sessions - a.sessions);
    const entry = trail[forkAt]?.sessions ?? node.sessions;
    const viable = next.filter((c) => c.sessions >= entry * tailThreshold);

    if (viable.length === 0 || trail.length >= maxDepth) {
      if (trail.length > 0) sequences.push({ seq: trail, forkAt });
      return;
    }

    const [heaviest, ...rest] = viable;
    walk(heaviest, [...trail, heaviest], forkAt);

    for (const sibling of rest) {
      if (sibling.sessions < heaviest.sessions * branchThreshold) break; // sorted, so the rest are smaller
      // The fork index moves to the sibling: everything before it is shared
      // with the main route and belongs to neither journey exclusively.
      walk(sibling, [...trail, sibling], trail.length);
    }
  };
  walk(root, [], 0);

  const journeys = sequences.map((s) => toJourney(s.seq, s.forkAt, root, revenueEvents, totalSessions));

  // Ranked by sessions lost at the worst step: "where is the biggest hole",
  // not "which path is most popular" — the popular path is the happy one.
  return journeys.sort((a, b) => b.impact - a.impact).slice(0, limit);
}

function toJourney(
  seq: TreeNode[],
  forkAt: number,
  root: TreeNode,
  revenueEvents: Set<string>,
  totalSessions: number,
): DiscoveredJourney {
  const entry = seq[forkAt].sessions;
  const steps: JourneyStep[] = [];

  let parent = root;
  for (let i = 0; i < seq.length; i++) {
    const node = seq[i];
    const prev = i === 0 ? null : seq[i - 1];
    const prevSessions = prev?.sessions ?? node.sessions;

    // Everyone who reached the previous step, split three ways: came here,
    // went to a sibling, or stopped. Only the third is a hole.
    const siblings =
      prev === null
        ? []
        : [...parent.children.values()]
            .filter((c) => c.event !== node.event)
            .sort((a, b) => b.sessions - a.sessions);
    const divertedTotal = siblings.reduce((sum, c) => sum + c.sessions, 0);
    const exited = prev === null ? 0 : Math.max(0, prevSessions - node.sessions - divertedTotal);

    steps.push({
      event: node.event,
      label: eventLabel(node.event),
      sessions: node.sessions,
      retention: i === 0 ? null : prevSessions > 0 ? node.sessions / prevSessions : null,
      exited,
      diverted: divertedTotal,
      divertedTo: siblings
        .slice(0, 3)
        .map((c) => ({ event: c.event, label: eventLabel(c.event), sessions: c.sessions })),
      shared: i < forkAt,
    });
    parent = node;
  }

  const terminal = seq[seq.length - 1];
  const outcome: DiscoveredJourney['outcome'] = revenueEvents.has(terminal.event) ? 'converts' : 'abandons';
  const completed = terminal.sessions;

  // Only the steps this journey owns, and not the fork step itself: the
  // sessions that ended at the fork's *parent* ended before this journey
  // existed, and belong to every sibling equally. Charging them here ranked
  // both journeys by the same shared number and printed the same finding twice.
  const worst = steps
    .slice(forkAt + 1)
    .reduce<JourneyStep | null>((a, s) => (a === null || s.exited > a.exited ? s : a), null);

  // Only meaningful where somebody on this journey actually paid. Inventing a
  // rate from a neighbouring journey would put a number on the screen that no
  // measurement supports.
  const revenuePerConverted = terminal.converted > 0 ? terminal.revenue / terminal.converted : null;
  const impact = worst?.exited ?? 0;

  return {
    id: seq.map((n) => n.event).join('>'),
    label: journeyLabel(seq, forkAt, outcome),
    steps,
    entrySessions: entry,
    forkAt,
    completedSessions: completed,
    conversion: entry > 0 ? completed / entry : 0,
    outcome,
    worstStep: worst
      ? { event: worst.event, label: worst.label, exited: worst.exited, retention: worst.retention ?? 0 }
      : null,
    impact,
    revenueAtRisk: revenuePerConverted === null ? null : impact * revenuePerConverted,
    shareOfSessions: totalSessions > 0 ? entry / totalSessions : 0,
  };
}

/**
 * A name a person can hold in their head — first step, last step, and the
 * distinguishing middle where there is one. Two journeys sharing endpoints get
 * different names, because "Session start → Purchase" twice on one screen is
 * useless.
 */
function journeyLabel(seq: TreeNode[], forkAt: number, outcome: DiscoveredJourney['outcome']): string {
  // Named from the fork, because that is what distinguishes it. Two journeys
  // both starting at `session_start` named "Session start → …" are two names
  // that do not tell them apart.
  const own = seq.slice(forkAt);
  const first = eventLabel(own[0].event);
  const last = eventLabel(own[own.length - 1].event);
  if (own.length === 1) return first;

  const middle = own.slice(1, -1);
  const via = middle.length ? middle[Math.floor(middle.length / 2)] : null;
  const base = via ? `${first} → ${eventLabel(via.event)} → ${last}` : `${first} → ${last}`;
  return outcome === 'converts' ? base : `${base} (no purchase)`;
}

/* ── comparison ──────────────────────────────────────────────────────────── */

export interface JourneyShift {
  id: string;
  label: string;
  /** Percentage points, current minus previous. `null` when unseen before. */
  conversionDeltaPp: number | null;
  entryDeltaPct: number | null;
  /** The step whose retention moved most, in percentage points. */
  movedStep: { event: string; label: string; deltaPp: number } | null;
  isNew: boolean;
}

/**
 * What changed between two windows.
 *
 * Journeys are matched by their step sequence, so a journey that only exists in
 * one window is reported as new rather than quietly compared against nothing —
 * a new path appearing is itself a finding, usually a release.
 */
export function compareJourneys(
  current: DiscoveredJourney[],
  previous: DiscoveredJourney[],
): JourneyShift[] {
  const before = new Map(previous.map((j) => [j.id, j]));
  return current.map((j) => {
    const p = before.get(j.id);
    if (!p) {
      return {
        id: j.id,
        label: j.label,
        conversionDeltaPp: null,
        entryDeltaPct: null,
        movedStep: null,
        isNew: true,
      };
    }
    const prevStep = new Map(p.steps.map((s) => [s.event, s]));
    let moved: JourneyShift['movedStep'] = null;
    for (const s of j.steps) {
      const q = prevStep.get(s.event);
      if (s.retention == null || q?.retention == null) continue;
      const deltaPp = (s.retention - q.retention) * 100;
      if (moved === null || Math.abs(deltaPp) > Math.abs(moved.deltaPp)) {
        moved = { event: s.event, label: s.label, deltaPp };
      }
    }
    return {
      id: j.id,
      label: j.label,
      conversionDeltaPp: (j.conversion - p.conversion) * 100,
      entryDeltaPct: p.entrySessions > 0 ? (j.entrySessions - p.entrySessions) / p.entrySessions : null,
      movedStep: moved,
      isNew: false,
    };
  });
}

/* ── findings ────────────────────────────────────────────────────────────── */

export interface JourneyFinding {
  severity: 'high' | 'medium' | 'low';
  journeyId: string;
  headline: string;
  detail: string;
  /** Populated only where a measured revenue rate exists. */
  revenueAtRisk: number | null;
}

/**
 * The deterministic read, produced before any model is called.
 *
 * The AI layer narrates these; it does not find them. Everything on the screen
 * therefore survives an expired API key, which is the same rule the anomaly and
 * RCA layers already follow — prose is the only part that needs a model.
 */
export function journeyFindings(
  journeys: DiscoveredJourney[],
  shifts: JourneyShift[] = [],
): JourneyFinding[] {
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const out: JourneyFinding[] = [];

  for (const j of journeys) {
    const shift = shiftById.get(j.id);

    if (j.worstStep && j.impact > 0) {
      const idx = j.steps.findIndex((s) => s.event === j.worstStep!.event);
      const step = j.steps[idx];
      const prev = j.steps[idx - 1];
      const base = prev?.sessions ?? j.entrySessions;
      const diversion = step?.divertedTo[0];
      out.push({
        severity: j.impact > j.entrySessions * 0.25 ? 'high' : 'medium',
        journeyId: j.id,
        // The headline is the exit rate, not `1 − retention`: the sessions that
        // forked elsewhere are still in the app, and calling them a drop is the
        // mistake this whole accounting exists to avoid.
        headline: `${Math.round((j.impact / Math.max(1, base)) * 100)}% leave after ${prev?.label ?? 'the previous step'}`,
        detail:
          `${j.impact.toLocaleString('en-IN')} of ${base.toLocaleString('en-IN')} sessions did nothing further after ` +
          `${prev?.label ?? 'the previous step'}, rather than continuing to ${j.worstStep.label}` +
          (diversion
            ? `. A further ${step.diverted.toLocaleString('en-IN')} took another route, most to ${diversion.label}.`
            : '.'),
        revenueAtRisk: j.revenueAtRisk,
      });
    }

    if (shift?.isNew && j.shareOfSessions > 0.05) {
      out.push({
        severity: 'medium',
        journeyId: j.id,
        headline: `New path: ${j.label}`,
        detail: `${Math.round(j.shareOfSessions * 100)}% of sessions took a route that did not exist in the previous window. A release or a config change usually explains this.`,
        revenueAtRisk: null,
      });
    }

    if (shift?.movedStep && Math.abs(shift.movedStep.deltaPp) >= 5) {
      const worse = shift.movedStep.deltaPp < 0;
      out.push({
        severity: worse && Math.abs(shift.movedStep.deltaPp) >= 10 ? 'high' : 'low',
        journeyId: j.id,
        headline: `${shift.movedStep.label} ${worse ? 'fell' : 'rose'} ${Math.abs(shift.movedStep.deltaPp).toFixed(1)}pp`,
        detail: `Retention into ${shift.movedStep.label} moved from ${(
          (j.steps.find((s) => s.event === shift.movedStep!.event)?.retention ?? 0) * 100 -
          shift.movedStep.deltaPp
        ).toFixed(1)}% to ${(
          (j.steps.find((s) => s.event === shift.movedStep!.event)?.retention ?? 0) * 100
        ).toFixed(1)}% against the comparison window.`,
        revenueAtRisk: null,
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * §5.2 `time_to_order_p50` — how long a converting session actually takes.
 *
 * Measured only over paths that **ended in a revenue event**, because the
 * question is how long buying takes, not how long a session lasts. Including
 * abandoned sessions would mix two populations and produce a number describing
 * neither — and abandoned sessions are the majority, so it would mostly measure
 * browsing.
 *
 * Returns milliseconds to match the metric's declared unit, and `null` rather
 * than `0` when nothing converted: a zero here reads as instant checkout.
 *
 * The input medians are per-path, so this is a weighted median of medians — an
 * approximation, and the registry caveat says so. The true pooled median needs
 * per-session durations, which the mart deliberately does not store.
 */
export function medianTimeToOrder(paths: JourneyPath[], _nodes: EventNode[]): number | null {
  // Companion has no GA4 revenue field; a converting session is one that fired
  // payment_success, which the connector counts into `convertedSessions`.
  const converting = paths.filter(
    (p) => p.medianSeconds != null && p.medianSeconds > 0 && p.convertedSessions > 0,
  );
  if (converting.length === 0) return null;

  // Weighted by converting sessions: a path taken by 4,000 buyers should not
  // count the same as one taken by six.
  const expanded = [...converting].sort((a, b) => (a.medianSeconds ?? 0) - (b.medianSeconds ?? 0));
  const total = expanded.reduce((sum, p) => sum + p.convertedSessions, 0);
  let seen = 0;
  for (const p of expanded) {
    seen += p.convertedSessions;
    if (seen >= total / 2) return (p.medianSeconds ?? 0) * 1000;
  }
  return (expanded[expanded.length - 1].medianSeconds ?? 0) * 1000;
}
