/**
 * §5 implemented once. Every formula in the metric dictionary lives here.
 *
 * Components import `MetricValue` objects from the API; they never compute.
 */
import type { DataSourceState } from '@/lib/connectors/types';
import type { MetricId } from './registry';
import { getMetric } from './registry';
import type { Thresholds } from '@/lib/db/settings';

export interface MetricValue {
  id: string;
  label: string;
  value: number | null;
  unit: 'count' | 'inr' | 'ratio' | 'ms' | 'score' | 'days';
  direction: 'up_good' | 'down_good' | 'neutral';
  /** Mandatory provenance — a KpiCard will not render without these (§9.2). */
  source: string;
  grain: string;
  fetchedAt: string;
  state: DataSourceState;
  formula: string;
  description: string;
  /** Comparison deltas, relative (0.12 = +12%). Null when no baseline. */
  deltaVsPrev?: number | null;
  deltaVsSameWeekdayLastWeek?: number | null;
  /** For rates, the honest unit for a change is percentage points. */
  deltaPp?: number | null;
  caveat?: string;
  ambiguous?: boolean;
  /** Set when `state` is 'not_instrumented' — names the missing event. */
  notInstrumentedReason?: string;
}

export function metricValue(
  id: MetricId | string,
  valueOrPresence: number | null | Presence,
  opts: {
    state?: DataSourceState;
    fetchedAt?: string;
    deltaVsPrev?: number | null;
    deltaVsSameWeekdayLastWeek?: number | null;
    deltaPp?: number | null;
    notInstrumentedReason?: string;
    sourceOverride?: string;
  } = {},
): MetricValue {
  const def = getMetric(id);
  if (!def) throw new Error(`Unknown metric id "${id}" — add it to §5 (lib/metrics/registry.ts) first`);

  // A Presence carries its own state, and it wins over the caller's default:
  // whoever computed the number knows whether the period was observed.
  const isPresence =
    valueOrPresence !== null && typeof valueOrPresence === 'object' && 'state' in valueOrPresence;
  const value = isPresence ? (valueOrPresence as Presence).value : (valueOrPresence as number | null);
  const presenceState = isPresence ? (valueOrPresence as Presence).state : undefined;
  const presenceReason = isPresence ? (valueOrPresence as Presence).reason : undefined;

  // A live-looking card with a null value is the exact ambiguity this guards.
  const resolvedState =
    presenceState === 'missing'
      ? 'missing'
      : (opts.state ?? presenceState ?? (value == null ? 'missing' : 'live'));

  return {
    id: def.id,
    label: def.label,
    value,
    unit: def.unit,
    direction: def.direction,
    source: opts.sourceOverride ?? def.source,
    grain: def.grain,
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
    state: resolvedState,
    formula: def.formula,
    description: def.description,
    deltaVsPrev: opts.deltaVsPrev ?? null,
    deltaVsSameWeekdayLastWeek: opts.deltaVsSameWeekdayLastWeek ?? null,
    deltaPp: opts.deltaPp ?? null,
    caveat: def.caveat,
    ambiguous: def.ambiguous,
    notInstrumentedReason: opts.notInstrumentedReason ?? presenceReason,
  };
}

/**
 * §5.8 / §9.2 / §28.8 — "Never substitute zero for missing."
 *
 * Three outcomes have to stay distinguishable, and a bare `0` collapses them:
 *
 *   0                 a real measured zero — nobody ordered today
 *   missing           no data exists for this grain in this window
 *   not_instrumented  the event is absent from the container entirely
 *
 * A metric computed over a period the data does not cover reads 0 and looks
 * like a business collapse. `presence()` forces the caller to say which case it
 * is, at the point where it is actually known.
 */
export interface Presence {
  value: number | null;
  state: DataSourceState;
  reason?: string;
}

export function measured(value: number): Presence {
  return { value, state: 'live' };
}

/** No data for this grain in this window — the value is unknown, not zero. */
export function noData(reason: string): Presence {
  return { value: null, state: 'missing', reason };
}

/**
 * Resolves a computed value against whether the underlying grain had any data
 * at all. `hasData` is the caller's assertion that the period was observed.
 */
export function presence(value: number | null, hasData: boolean, reason: string): Presence {
  if (!hasData) return noData(reason);
  if (value == null) return noData(reason);
  return { value, state: 'live' };
}

/* ── Safe arithmetic ─────────────────────────────────────────────────────── */

export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = clamp(Math.ceil((p / 100) * s.length) - 1, 0, s.length - 1);
  return s[idx];
}

/** Relative change. Null when the baseline is zero — not Infinity, not 0. */
export function relativeDelta(current: number | null, baseline: number | null): number | null {
  if (current == null || baseline == null || baseline === 0) return null;
  return current / baseline - 1;
}

/** Percentage-point change, for rates. */
export function ppDelta(current: number | null, baseline: number | null): number | null {
  if (current == null || baseline == null) return null;
  return current - baseline;
}

/* ── §5.1 Business ───────────────────────────────────────────────────────── */

export interface OrderLike {
  orderId: string;
  orderDate: string;
  storeId: string;
  status: string;
  statusConfirmed: boolean;
  units: number;
  grossValue: number;
  discountAmount: number;
  couponAmount: number;
  couponCode: string | null;
  netValue: number;
  customerId: string;
  isNewCustomer: boolean;
}

export interface BusinessAggregate {
  orders: number;
  ordersConfirmed: number;
  egmv: number;
  netRevenue: number;
  totalUnits: number;
  discountTotal: number;
  couponTotal: number;
  ordersWithCoupon: number;
  newCustomers: number;
  repeatCustomers: number;
  distinctCustomers: number;
}

export function aggregateOrders(orders: OrderLike[]): BusinessAggregate {
  // A3 — both variants computed while the status enum is unconfirmed (§15.4).
  const confirmed = orders.filter((o) => o.statusConfirmed);
  const customers = new Set(orders.map((o) => o.customerId).filter(Boolean));
  const newCust = new Set(orders.filter((o) => o.isNewCustomer).map((o) => o.customerId));
  return {
    orders: new Set(orders.map((o) => o.orderId)).size,
    ordersConfirmed: new Set(confirmed.map((o) => o.orderId)).size,
    egmv: sum(confirmed.map((o) => o.grossValue)),
    netRevenue: sum(confirmed.map((o) => o.netValue)),
    totalUnits: sum(confirmed.map((o) => o.units)),
    discountTotal: sum(confirmed.map((o) => o.discountAmount)),
    couponTotal: sum(confirmed.map((o) => o.couponAmount)),
    ordersWithCoupon: confirmed.filter((o) => o.couponCode).length,
    newCustomers: newCust.size,
    repeatCustomers: customers.size - newCust.size,
    distinctCustomers: customers.size,
  };
}

export const business = {
  orders: (a: BusinessAggregate) => a.orders,
  ordersConfirmed: (a: BusinessAggregate) => a.ordersConfirmed,
  egmv: (a: BusinessAggregate) => a.egmv,
  netRevenue: (a: BusinessAggregate) => a.netRevenue,
  aov: (a: BusinessAggregate) => ratio(a.netRevenue, a.ordersConfirmed),
  unitsPerOrder: (a: BusinessAggregate) => ratio(a.totalUnits, a.ordersConfirmed),
  discountRate: (a: BusinessAggregate) => ratio(a.discountTotal + a.couponTotal, a.egmv),
  couponAttachRate: (a: BusinessAggregate) => ratio(a.ordersWithCoupon, a.ordersConfirmed),
  newCustomers: (a: BusinessAggregate) => a.newCustomers,
  repeatRate: (a: BusinessAggregate) => ratio(a.repeatCustomers, a.distinctCustomers),
};

/* ── §5.2 Journey ────────────────────────────────────────────────────────── */

export interface FunnelStepAggregate {
  step: string;
  stepOrder: number;
  eventCount: number;
  sessionCount: number;
  userCount: number;
  isInstrumented: boolean;
}

export function aggregateFunnel(
  rows: Array<{
    step: string;
    stepOrder: number;
    eventCount: number;
    sessionCount: number;
    userCount: number;
    isInstrumented: boolean;
  }>,
): FunnelStepAggregate[] {
  const byStep = new Map<string, FunnelStepAggregate>();
  for (const r of rows) {
    const cur = byStep.get(r.step) ?? {
      step: r.step,
      stepOrder: r.stepOrder,
      eventCount: 0,
      sessionCount: 0,
      userCount: 0,
      isInstrumented: r.isInstrumented,
    };
    cur.eventCount += r.eventCount;
    cur.sessionCount += r.sessionCount;
    cur.userCount += r.userCount;
    // If any slice says the event is uninstrumented, the step is uninstrumented.
    cur.isInstrumented = cur.isInstrumented && r.isInstrumented;
    byStep.set(r.step, cur);
  }
  return [...byStep.values()].sort((a, b) => a.stepOrder - b.stepOrder);
}

function stepCount(steps: FunnelStepAggregate[], name: string): number | null {
  const s = steps.find((x) => x.step === name);
  // §16.9 — an uninstrumented step is null, never zero. The distinction is the
  // difference between "nobody did this" and "we never measured it".
  if (!s || !s.isInstrumented) return null;
  return s.eventCount;
}

export const journey = {
  scanSuccessRate: (s: FunnelStepAggregate[]) =>
    ratioOrNull(stepCount(s, 'scan_success'), stepCount(s, 'scan_attempt')),
  atcRate: (s: FunnelStepAggregate[]) =>
    ratioOrNull(stepCount(s, 'add_to_cart'), stepCount(s, 'scan_success')),
  checkoutRate: (s: FunnelStepAggregate[]) =>
    ratioOrNull(stepCount(s, 'begin_checkout'), stepCount(s, 'view_cart')),
  // Companion has no add_payment_info event, so the rate is the app's own
  // success vs failure: payment_success ÷ (payment_success + payment_failure).
  // (`purchase` is the internal step key for the payment_success event.)
  paymentSuccessRate: (s: FunnelStepAggregate[]) => {
    const ok = stepCount(s, 'purchase');
    if (ok == null) return null;
    const fail = stepCount(s, 'payment_failure') ?? 0;
    return ratioOrNull(ok, ok + fail);
  },
  sessionConversion: (s: FunnelStepAggregate[]) =>
    ratioOrNull(stepCount(s, 'purchase'), stepCount(s, 'session_start')),
  /** `1 − (step_{n+1} / step_n)`, ranked worst first by the caller. */
  stepDropoff: (s: FunnelStepAggregate[]) =>
    s.slice(0, -1).map((step, i) => {
      const next = s[i + 1];
      const from = step.isInstrumented ? step.eventCount : null;
      const to = next.isInstrumented ? next.eventCount : null;
      const conv = ratioOrNull(to, from);
      return {
        from: step.step,
        to: next.step,
        fromCount: from,
        toCount: to,
        conversion: conv,
        dropoff: conv == null ? null : 1 - conv,
        instrumented: step.isInstrumented && next.isInstrumented,
      };
    }),
};

function ratioOrNull(n: number | null, d: number | null): number | null {
  if (n == null || d == null || d === 0) return null;
  return n / d;
}

/* ── §5.3 Store adoption (store and state grain) ─────────────────────────── */

export interface StoreDailyLike {
  dateKey: string;
  storeId: string;
  orders: number;
  revenue: number;
  scans: number;
  sessions: number;
}

export interface StoreDim {
  storeId: string;
  storeCode: string;
  storeName: string;
  city: string;
  state: string;
  region: string;
  companionLive: boolean;
  activatedOn: string | null;
}

export interface StoreRollup {
  storeId: string;
  storeCode: string;
  storeName: string;
  city: string;
  state: string;
  region: string;
  activatedOn: string | null;
  /** Orders on `asOf` — the window's last day, not the wall clock. */
  ordersOnLatestDay: number;
  /** Orders across the whole selected window — the basis for active/dark. */
  ordersInWindow: number;
  orders7d: number;
  orders28d: number;
  revenue28d: number;
  scans28d: number;
  scanSuccessRate: number | null;
  coverage: number | null;
  lastOrderDate: string | null;
  daysSinceLastOrder: number | null;
  isDark: boolean;
}

/**
 * `asOf` is the window's last day, never the wall clock.
 *
 * Trailing windows end yesterday, because today is partial and a half-day of
 * orders compared against a full one is not a comparison. Anchoring "today" to
 * the wall clock therefore looked for orders on a date the window does not
 * contain, found none, and reported every store as having sold nothing.
 */
export function rollupStores(
  dims: StoreDim[],
  daily: StoreDailyLike[],
  asOf: string,
  coverageByStore: Map<string, { scans: number; failed: number }> = new Map(),
): StoreRollup[] {
  const byStore = new Map<string, StoreDailyLike[]>();
  for (const d of daily) {
    const list = byStore.get(d.storeId) ?? [];
    list.push(d);
    byStore.set(d.storeId, list);
  }
  const dayDiff = (a: string, b: string) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

  return dims
    .filter((s) => s.companionLive)
    .map((s) => {
      const rows = byStore.get(s.storeId) ?? [];
      const withOrders = rows.filter((r) => r.orders > 0);
      const lastOrderDate =
        withOrders.length > 0 ? withOrders.map((r) => r.dateKey).sort().at(-1)! : null;
      const daysSince = lastOrderDate ? dayDiff(lastOrderDate, asOf) : null;
      const inLast = (n: number) => rows.filter((r) => dayDiff(r.dateKey, asOf) < n);
      const cov = coverageByStore.get(s.storeId);
      return {
        storeId: s.storeId,
        storeCode: s.storeCode,
        storeName: s.storeName,
        city: s.city,
        state: s.state,
        region: s.region,
        activatedOn: s.activatedOn,
        ordersOnLatestDay: sum(rows.filter((r) => r.dateKey === asOf).map((r) => r.orders)),
        // The passed rows are already limited to the selected window, so their
        // sum is orders-in-window. active/dark are defined on this, so the window
        // filter actually changes them (a 90-day window shows every store that
        // ordered in 90 days, not just the last 7).
        ordersInWindow: sum(rows.map((r) => r.orders)),
        orders7d: sum(inLast(7).map((r) => r.orders)),
        orders28d: sum(inLast(28).map((r) => r.orders)),
        revenue28d: sum(inLast(28).map((r) => r.revenue)),
        scans28d: sum(inLast(28).map((r) => r.scans)),
        scanSuccessRate: cov ? ratio(cov.scans - cov.failed, cov.scans) : null,
        coverage: cov ? ratio(cov.scans - cov.failed, cov.scans) : null,
        lastOrderDate,
        daysSinceLastOrder: daysSince,
        isDark: sum(rows.map((r) => r.orders)) === 0,
      };
    });
}

export interface StateRollup {
  state: string;
  region: string;
  storesLive: number;
  storesActive: number;
  storesDark: number;
  orders28d: number;
  revenue28d: number;
  coverage: number | null;
  activationPct: number | null;
}

/** State-level rollup — the geographic grain leadership asks for. */
export function rollupStates(stores: StoreRollup[], totalByState?: Map<string, number>): StateRollup[] {
  const byState = new Map<string, StoreRollup[]>();
  for (const s of stores) {
    const list = byState.get(s.state) ?? [];
    list.push(s);
    byState.set(s.state, list);
  }
  return [...byState.entries()]
    .map(([state, rows]) => {
      const coverages = rows.map((r) => r.coverage).filter((c): c is number => c != null);
      const total = totalByState?.get(state);
      return {
        state,
        region: rows[0]?.region ?? '',
        storesLive: rows.length,
        storesActive: rows.filter((r) => r.ordersInWindow > 0).length,
        storesDark: rows.filter((r) => r.isDark).length,
        orders28d: sum(rows.map((r) => r.orders28d)),
        revenue28d: sum(rows.map((r) => r.revenue28d)),
        coverage: coverages.length ? sum(coverages) / coverages.length : null,
        activationPct: total ? rows.length / total : null,
      };
    })
    .sort((a, b) => b.revenue28d - a.revenue28d);
}

/* ── §5.4 Catalogue ──────────────────────────────────────────────────────── */

export interface ScanLike {
  dateKey: string;
  storeId: string;
  ean: string;
  result: 'found' | 'not_found';
  scanCount: number;
}

export interface CoverageAggregate {
  totalScans: number;
  totalFailed: number;
  uniqueScans: number;
  uniqueFailed: number;
  uniqueCoverage: number | null;
  totalCoverage: number | null;
}

/**
 * Window-level coverage from EAN-level rows. Distinct counts must be taken over
 * the whole window — summing daily distinct counts double-counts any EAN
 * scanned on more than one day, which quietly inflates the denominator.
 */
export function aggregateCoverage(scans: ScanLike[]): CoverageAggregate {
  const uniq = new Set<string>();
  const uniqFailed = new Set<string>();
  let totalScans = 0;
  let totalFailed = 0;
  for (const s of scans) {
    uniq.add(s.ean);
    totalScans += s.scanCount;
    if (s.result === 'not_found') {
      uniqFailed.add(s.ean);
      totalFailed += s.scanCount;
    }
  }
  return {
    totalScans,
    totalFailed,
    uniqueScans: uniq.size,
    uniqueFailed: uniqFailed.size,
    uniqueCoverage: ratio(uniq.size - uniqFailed.size, uniq.size),
    totalCoverage: ratio(totalScans - totalFailed, totalScans),
  };
}

export function coverageByStore(scans: ScanLike[]): Map<string, { scans: number; failed: number }> {
  const m = new Map<string, { eans: Set<string>; failed: Set<string> }>();
  for (const s of scans) {
    const cur = m.get(s.storeId) ?? { eans: new Set(), failed: new Set() };
    cur.eans.add(s.ean);
    if (s.result === 'not_found') cur.failed.add(s.ean);
    m.set(s.storeId, cur);
  }
  return new Map([...m].map(([k, v]) => [k, { scans: v.eans.size, failed: v.failed.size }]));
}

/** §4.5 — aging buckets. A 30-day-old miss is an ownership failure. */
export function gapAgeBuckets(
  gaps: Array<{ firstSeen: string; status: string }>,
  today: string,
): Array<{ bucket: string; count: number }> {
  const open = gaps.filter((g) => g.status !== 'resolved' && g.status !== 'wontfix');
  const age = (d: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000);
  const buckets = [
    { bucket: '0–1 d', test: (a: number) => a <= 1 },
    { bucket: '2–7 d', test: (a: number) => a >= 2 && a <= 7 },
    { bucket: '8–30 d', test: (a: number) => a >= 8 && a <= 30 },
    { bucket: '30 d+', test: (a: number) => a > 30 },
  ];
  return buckets.map((b) => ({ bucket: b.bucket, count: open.filter((g) => b.test(age(g.firstSeen))).length }));
}

/* ── §5.8 App Health Score ───────────────────────────────────────────────── */

export interface ScoreComponent {
  id: string;
  label: string;
  /** 0..1 normalised contribution before weighting. */
  normalised: number | null;
  weight: number;
  included: boolean;
  raw: number | null;
}

export interface AppHealthScore {
  score: number | null;
  band: 'green' | 'amber' | 'red' | 'unknown';
  components: ScoreComponent[];
  missingComponents: string[];
  /** True when weights were renormalised because a component had no data. */
  renormalised: boolean;
  totalWeightAvailable: number;
}

export interface HealthInputs {
  crashFreeRate: number | null;
  paymentSuccessRate: number | null;
  apiErrorRate: number | null;
  /** endpoint id → { sloP95, actualP95 } */
  latency: Array<{ endpoint: string; sloP95Ms: number; actualP95Ms: number | null }>;
  p0Open: number | null;
}

/**
 * §5.8 — always decomposable, never a black box.
 *
 * Any component with no data is excluded and the weights renormalised, with the
 * UI naming which components are missing. Never substitute zero for missing —
 * that turns a monitoring gap into a false alarm.
 */
export function appHealthScore(inputs: HealthInputs, t: Thresholds): AppHealthScore {
  const w = t.health_weights;

  const latencyScore = (() => {
    const usable = inputs.latency.filter((l) => l.actualP95Ms != null && l.actualP95Ms > 0);
    if (usable.length === 0) return null;
    return (
      sum(usable.map((l) => clamp(l.sloP95Ms / (l.actualP95Ms as number), 0, 1))) / usable.length
    );
  })();

  const components: ScoreComponent[] = [
    {
      id: 'crash_free',
      label: 'Crash-free sessions',
      normalised: inputs.crashFreeRate,
      weight: w.crash_free,
      included: inputs.crashFreeRate != null,
      raw: inputs.crashFreeRate,
    },
    {
      id: 'payment_success',
      label: 'Payment success',
      normalised: inputs.paymentSuccessRate,
      weight: w.payment_success,
      included: inputs.paymentSuccessRate != null,
      raw: inputs.paymentSuccessRate,
    },
    {
      id: 'api_error',
      label: 'API error rate',
      normalised:
        inputs.apiErrorRate == null ? null : 1 - clamp(inputs.apiErrorRate / t.api_error_ceiling, 0, 1),
      weight: w.api_error,
      included: inputs.apiErrorRate != null,
      raw: inputs.apiErrorRate,
    },
    {
      id: 'latency',
      label: 'Latency vs SLO',
      normalised: latencyScore,
      weight: w.latency,
      included: latencyScore != null,
      raw: latencyScore,
    },
    {
      id: 'p0',
      label: 'Open P0s',
      normalised: inputs.p0Open == null ? null : 1 - clamp(inputs.p0Open / t.p0_ceiling, 0, 1),
      weight: w.p0,
      included: inputs.p0Open != null,
      raw: inputs.p0Open,
    },
  ];

  const included = components.filter((c) => c.included && c.normalised != null);
  const missing = components.filter((c) => !c.included || c.normalised == null).map((c) => c.label);
  const totalWeight = sum(included.map((c) => c.weight));

  if (included.length === 0 || totalWeight === 0) {
    return {
      score: null,
      band: 'unknown',
      components,
      missingComponents: missing,
      renormalised: false,
      totalWeightAvailable: 0,
    };
  }

  // Renormalise across available weight rather than treating missing as zero.
  const raw = sum(included.map((c) => c.weight * (c.normalised as number)));
  const score = (raw / totalWeight) * 100;

  return {
    score,
    band: score >= 90 ? 'green' : score >= 75 ? 'amber' : 'red',
    components,
    missingComponents: missing,
    renormalised: missing.length > 0,
    totalWeightAvailable: totalWeight,
  };
}

/* ── §5.7 Issues ─────────────────────────────────────────────────────────── */

export interface IssueLike {
  issueKey: string;
  priority: string;
  status: string;
  /** From Jira statusCategory — the reliable "done" signal (see fact_issues). */
  isDone: boolean;
  assignee: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export const issues = {
  p0Open: (xs: IssueLike[]) => xs.filter((i) => i.priority === 'P0' && !i.isDone).length,
  p1Open: (xs: IssueLike[]) => xs.filter((i) => i.priority === 'P1' && !i.isDone).length,
  p0AgeP50: (xs: IssueLike[], now = Date.now()) =>
    median(
      xs
        .filter((i) => i.priority === 'P0' && !i.isDone)
        .map((i) => (now - Date.parse(i.createdAt)) / 86_400_000),
    ),
  unowned: (xs: IssueLike[]) => xs.filter((i) => !i.isDone && !i.assignee).length,
  openCloseRatio: (xs: IssueLike[], now = Date.now()) => {
    const cutoff = now - 7 * 86_400_000;
    const opened = xs.filter((i) => Date.parse(i.createdAt) >= cutoff).length;
    const closed = xs.filter((i) => i.resolvedAt && Date.parse(i.resolvedAt) >= cutoff).length;
    return ratio(opened, closed);
  },
};
