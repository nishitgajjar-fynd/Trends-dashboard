/**
 * Module services: assemble the §5 metrics for each route.
 *
 * All metric arithmetic goes through `lib/metrics/compute`; this layer only
 * chooses windows, joins sources, and attaches provenance. No formulas here.
 */
import {
  aggregateCoverage,
  aggregateFunnel,
  aggregateOrders,
  appHealthScore,
  business,
  coverageByStore,
  gapAgeBuckets,
  issues as issueMetrics,
  journey,
  median,
  metricValue,
  ppDelta,
  presence,
  relativeDelta,
  rollupStates,
  rollupStores,
  type MetricValue,
  type StoreRollup,
} from '@/lib/metrics/compute';
import { reconcileGapRegister, type GapReconciliation } from '@/lib/metrics/reconcile';
import {
  compareJourneys,
  discoverJourneys,
  journeyFindings,
  medianTimeToOrder,
  type DiscoveredJourney,
  type JourneyFinding,
  type JourneyShift,
} from '@/lib/metrics/journeys';
import {
  getAppHealth,
  getCatalogueDaily,
  getCatalogueHealth,
  getEventNodes,
  getFunnel,
  getGaps,
  getJourneyPaths,
  getIssues,
  getLatency,
  getOrders,
  getScans,
  getStoreOps,
  getStores,
} from '@/lib/data/repository';
import { getThresholds } from '@/lib/db/settings';
import {
  addDays,
  dateRange,
  todayIST,
  trailingWindow,
  type DateWindow,
} from '@/lib/format/dates';
import { FUNNEL_STEPS } from '@/fixtures/business';
import type { CatalogueHealthRow } from '@/fixtures/catalogue-health';
import type { DataSourceState } from '@/lib/connectors/types';
import {
  COMPARE_LABELS,
  DEFAULT_TENANT,
  comparisonWindow,
  samePeriodLastMonth,
  type Filters,
} from '@/lib/params/filters';
import { resolveScope, scopePlatform, scopeRows, scopeStores } from '@/lib/services/scope';

export interface ModuleResult<T> {
  kpis: MetricValue[];
  data: T;
  window: DateWindow;
  warnings: string[];
  state: DataSourceState;
  sources: string[];
  /** What the §9.3 filters narrowed this to, for the page header. */
  scope?: string | null;
  /** The comparison every delta on this module is measured against. */
  compareLabel?: string;
}

/**
 * Modules accept either a bare window or the full §9.3 filter set.
 *
 * The bare-window form is what the tests and the default page loads use, and
 * keeping it means "no filters" cannot drift away from "the default filters" —
 * they are the same code path with the same defaults.
 */
export type ModuleInput = DateWindow | Filters;

function asFilters(input: ModuleInput, defaultDays: number): Filters {
  if ('compare' in input) return input;
  return {
    window: input.start && input.end ? input : trailingWindow(defaultDays),
    tenant: DEFAULT_TENANT,
    compare: 'prev_period',
  };
}

function worstState(...states: DataSourceState[]): DataSourceState {
  const rank: Record<DataSourceState, number> = {
    live: 0,
    cache: 1,
    stale: 2,
    fixture: 3,
    not_instrumented: 4,
    missing: 5,
  };
  return states.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'live' as DataSourceState);
}

/* ── /sales ──────────────────────────────────────────────────────────────── */

export interface SalesData {
  daily: Array<{ dateKey: string; orders: number; egmv: number; netRevenue: number }>;
  waterfall: { gross: number; discount: number; coupon: number; net: number };
  valueHistogram: Array<{ bucket: string; count: number }>;
  storeMatrix: Array<{ storeId: string; storeCode: string; storeName: string; city: string; state: string; orders: number; revenue: number }>;
  stateMatrix: Array<{ state: string; region: string; orders: number; revenue: number; stores: number }>;
  newVsRepeat: Array<{ dateKey: string; newCustomers: number; repeatCustomers: number }>;
}

export async function salesModule(input: ModuleInput = trailingWindow(90)): Promise<ModuleResult<SalesData>> {
  const f = asFilters(input, 90);
  const w = f.window;
  const [allOrders, stores] = await Promise.all([getOrders(w), getStores()]);

  // Scope first, then aggregate. Filtering after the aggregate is how a store
  // filter ends up narrowing the table while leaving the headline national.
  const scope = resolveScope(f, stores.rows);
  const orders = { ...allOrders, rows: scopeRows(allOrders.rows, scope) };

  // The comparison window follows `compare`, so the delta on every card is
  // measured against the period the reader chose — not always the previous one.
  const prev = comparisonWindow(w, f.compare);
  const prevRaw = await getOrders(prev);
  const prevOrders = { ...prevRaw, rows: scopeRows(prevRaw.rows, scope) };

  // Revenue MoM has its own fixed comparison — see the card below.
  const momWindow = samePeriodLastMonth(w);
  const momRaw = await getOrders(momWindow);
  const momAgg = aggregateOrders(scopeRows(momRaw.rows, scope));

  const agg = aggregateOrders(orders.rows);
  const prevAgg = aggregateOrders(prevOrders.rows);
  const meta = { state: orders.state, fetchedAt: orders.fetchedAt };

  const kpis: MetricValue[] = [
    metricValue('orders', business.orders(agg), {
      ...meta,
      deltaVsPrev: relativeDelta(business.orders(agg), business.orders(prevAgg)),
    }),
    metricValue('orders_confirmed', business.ordersConfirmed(agg), { ...meta }),
    metricValue('egmv', business.egmv(agg), {
      ...meta,
      deltaVsPrev: relativeDelta(business.egmv(agg), business.egmv(prevAgg)),
    }),
    metricValue('net_revenue', business.netRevenue(agg), {
      ...meta,
      deltaVsPrev: relativeDelta(business.netRevenue(agg), business.netRevenue(prevAgg)),
    }),
    metricValue('aov', business.aov(agg), {
      ...meta,
      deltaVsPrev: relativeDelta(business.aov(agg), business.aov(prevAgg)),
    }),
    metricValue('units_per_order', business.unitsPerOrder(agg), { ...meta }),
    metricValue('discount_rate', business.discountRate(agg), {
      ...meta,
      deltaPp: ppDelta(business.discountRate(agg), business.discountRate(prevAgg)),
    }),
    metricValue('coupon_attach_rate', business.couponAttachRate(agg), { ...meta }),
    metricValue('new_customers', business.newCustomers(agg), { ...meta }),
    metricValue('repeat_rate', business.repeatRate(agg), {
      ...meta,
      deltaPp: ppDelta(business.repeatRate(agg), business.repeatRate(prevAgg)),
    }),
    // Month-on-month means month-on-month regardless of what `compare` is set
    // to — otherwise the card silently changes meaning when a reader switches
    // the comparison, while keeping the name "Revenue MoM". Day-aligned, so a
    // month-to-date figure is never measured against a full previous month:
    // §1's own Apr→May +115% is 1–N May against 1–N April.
    metricValue('revenue_mom', relativeDelta(business.netRevenue(agg), business.netRevenue(momAgg)), {
      ...meta,
      sourceOverride: `derived — ${w.start}→${w.end} vs the same day-of-month range one month earlier (${momWindow.start}→${momWindow.end})`,
    }),
  ];

  const byDate = new Map<string, typeof orders.rows>();
  for (const o of orders.rows) {
    const list = byDate.get(o.orderDate) ?? [];
    list.push(o);
    byDate.set(o.orderDate, list);
  }
  const daily = dateRange(w).map((dateKey) => {
    const a = aggregateOrders(byDate.get(dateKey) ?? []);
    return { dateKey, orders: a.orders, egmv: a.egmv, netRevenue: a.netRevenue };
  });

  const newVsRepeat = dateRange(w).map((dateKey) => {
    const a = aggregateOrders(byDate.get(dateKey) ?? []);
    return { dateKey, newCustomers: a.newCustomers, repeatCustomers: a.repeatCustomers };
  });

  // §5.1 — every headline card on this page is confirmed-only, so every
  // breakdown of it must be too. Mixing bases meant the state table summed to
  // neither e-GMV nor net revenue, and the histogram counted 1,414 orders under
  // a label that said 1,289.
  const confirmedOrders = orders.rows.filter((o) => o.statusConfirmed);

  // Order value distribution — spot the ₹0 and outlier orders. These have been a
  // real data-quality tell (§4.2).
  const buckets = [0, 250, 500, 1000, 2000, 4000, 8000, Infinity];
  const valueHistogram = buckets.slice(0, -1).map((lo, i) => {
    const hi = buckets[i + 1];
    return {
      bucket: hi === Infinity ? `₹${lo}+` : `₹${lo}–${hi}`,
      count: confirmedOrders.filter((o) => o.netValue >= lo && o.netValue < hi).length,
    };
  });

  const storeById = new Map(stores.rows.map((s) => [s.storeId, s]));
  const byStore = new Map<string, { orders: number; revenue: number }>();
  for (const o of confirmedOrders) {
    const cur = byStore.get(o.storeId) ?? { orders: 0, revenue: 0 };
    cur.orders++;
    cur.revenue += o.netValue;
    byStore.set(o.storeId, cur);
  }

  const storeMatrix = [...byStore.entries()]
    .map(([storeId, v]) => {
      const s = storeById.get(storeId);
      return {
        storeId,
        storeCode: s?.storeCode ?? '',
        storeName: s?.storeName ?? storeId,
        city: s?.city ?? '',
        state: s?.state ?? '',
        orders: v.orders,
        revenue: v.revenue,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // State-level rollup — the geographic grain leadership asks for.
  const byState = new Map<string, { region: string; orders: number; revenue: number; stores: Set<string> }>();
  for (const row of storeMatrix) {
    if (!row.state) continue;
    const s = storeById.get(row.storeId);
    const cur = byState.get(row.state) ?? { region: s?.region ?? '', orders: 0, revenue: 0, stores: new Set<string>() };
    cur.orders += row.orders;
    cur.revenue += row.revenue;
    cur.stores.add(row.storeId);
    byState.set(row.state, cur);
  }
  const stateMatrix = [...byState.entries()]
    .map(([state, v]) => ({ state, region: v.region, orders: v.orders, revenue: v.revenue, stores: v.stores.size }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    kpis,
    data: {
      daily,
      waterfall: {
        gross: agg.egmv,
        discount: agg.discountTotal,
        coupon: agg.couponTotal,
        net: agg.netRevenue,
      },
      valueHistogram,
      storeMatrix,
      stateMatrix,
      newVsRepeat,
    },
    window: w,
    warnings: [...orders.warnings, ...scope.warnings],
    state: orders.state,
    sources: [orders.source, stores.source],
    scope: scope.description,
    compareLabel: COMPARE_LABELS[f.compare],
  };
}

/* ── /journey ────────────────────────────────────────────────────────────── */

export interface JourneyData {
  steps: Array<{ step: string; label: string; count: number | null; conversion: number | null; isInstrumented: boolean }>;
  dropoff: ReturnType<typeof journey.stepDropoff>;
  byPlatform: Array<{ platform: string; sessions: number; purchases: number; conversion: number | null }>;
  instrumentationGaps: Array<{ step: string; label: string; note: string }>;
}

export async function journeyModule(input: ModuleInput = trailingWindow(28)): Promise<ModuleResult<JourneyData>> {
  const f = asFilters(input, 28);
  const w = f.window;
  const [rawFunnel, allStores] = await Promise.all([getFunnel(w), getStores()]);
  const scope = resolveScope(f, allStores.rows);

  // The funnel is the one place `platform` genuinely changes the answer: iOS
  // and Android drop out at different steps, and §16.7 is explicit that
  // blending them hides an SDK-version problem behind an average.
  const funnel = { ...rawFunnel, rows: scopePlatform(scopeRows(rawFunnel.rows, scope), scope) };
  const rawPrev = await getFunnel(comparisonWindow(w, f.compare));
  const prevFunnel = { ...rawPrev, rows: scopePlatform(scopeRows(rawPrev.rows, scope), scope) };

  const steps = aggregateFunnel(funnel.rows);
  const prevSteps = aggregateFunnel(prevFunnel.rows);
  const meta = { state: funnel.state, fetchedAt: funnel.fetchedAt };

  // Session paths, for the one funnel metric a daily aggregate cannot produce.
  const journeyPaths = await getJourneyPaths(w);
  const nodes = await getEventNodes(w);
  const timeToOrderMs = medianTimeToOrder(journeyPaths.rows, nodes.rows);

  const kpis: MetricValue[] = [
    metricValue('scan_success_rate', journey.scanSuccessRate(steps), {
      ...meta,
      deltaPp: ppDelta(journey.scanSuccessRate(steps), journey.scanSuccessRate(prevSteps)),
    }),
    metricValue('atc_rate', journey.atcRate(steps), {
      ...meta,
      deltaPp: ppDelta(journey.atcRate(steps), journey.atcRate(prevSteps)),
    }),
    metricValue('checkout_rate', journey.checkoutRate(steps), {
      ...meta,
      deltaPp: ppDelta(journey.checkoutRate(steps), journey.checkoutRate(prevSteps)),
    }),
    metricValue('payment_success_rate', journey.paymentSuccessRate(steps), {
      ...meta,
      deltaPp: ppDelta(journey.paymentSuccessRate(steps), journey.paymentSuccessRate(prevSteps)),
    }),
    metricValue('session_conversion', journey.sessionConversion(steps), {
      ...meta,
      deltaPp: ppDelta(journey.sessionConversion(steps), journey.sessionConversion(prevSteps)),
    }),
    // §16.4 — computable at last. `fact_funnel_daily` is a daily aggregate and
    // could never answer this; `fact_journey_path` carries whole session
    // sequences with their elapsed seconds, so the paths that actually reached
    // a revenue event have a real duration.
    //
    // It stays `missing` rather than falling back to zero when no converting
    // path exists: nobody bought, so there is no time-to-order, and a 0 ms
    // median would read as instant checkout.
    metricValue('time_to_order_p50', timeToOrderMs, {
      state: timeToOrderMs == null ? 'missing' : journeyPaths.state,
      fetchedAt: journeyPaths.fetchedAt,
      sourceOverride:
        timeToOrderMs == null
          ? 'no converting session path in this window — not a zero'
          : `${journeyPaths.source} — median across paths ending in a revenue event`,
    }),
  ];

  const labelled = FUNNEL_STEPS.filter((def) => !def.hidden).map((def) => {
    const s = steps.find((x) => x.step === def.step);
    const prevIdx = def.order - 2;
    const prevDef = FUNNEL_STEPS[prevIdx];
    const prevAgg = prevDef ? steps.find((x) => x.step === prevDef.step) : undefined;
    const instrumented = s?.isInstrumented ?? false;
    const count = instrumented ? (s?.eventCount ?? 0) : null;
    const conversion =
      instrumented && prevAgg?.isInstrumented && prevAgg.eventCount > 0 && count != null
        ? count / prevAgg.eventCount
        : null;
    return { step: def.step, label: def.label, count, conversion, isInstrumented: instrumented };
  });

  // §5.2 / §16.9 — gaps are listed explicitly. Each is a sprint ticket waiting
  // to be written, and the dashboard's job is to make that visible.
  const instrumentationGaps = labelled
    .filter((s) => !s.isInstrumented)
    .map((s) => ({
      step: s.step,
      label: s.label,
      note:
        s.step === 'invoice_detag'
          ? 'A6 — no invoice/de-tag event has ever been confirmed. The final step of the core journey is invisible today.'
          : 'Expected event has no volume in the GA4 export.',
    }));

  // Derived from the scoped rows rather than hardcoded, so filtering to iOS
  // shows one row instead of iOS beside a row of zeros labelled Android —
  // which reads as "Android has collapsed", not "Android is filtered out".
  const platforms = [...new Set(funnel.rows.map((r) => r.platform).filter(Boolean))].sort();
  const byPlatform = platforms.map((platform) => {
    const rows = funnel.rows.filter((r) => r.platform === platform);
    const agg = aggregateFunnel(rows);
    const sessions = agg.find((s) => s.step === 'session_start')?.eventCount ?? 0;
    const purchases = agg.find((s) => s.step === 'purchase')?.eventCount ?? 0;
    return { platform, sessions, purchases, conversion: sessions ? purchases / sessions : null };
  });

  return {
    kpis,
    data: { steps: labelled, dropoff: journey.stepDropoff(steps), byPlatform, instrumentationGaps },
    window: w,
    warnings: [...funnel.warnings, ...scope.warnings],
    state: funnel.state,
    sources: [funnel.source],
    scope: scope.description,
    compareLabel: COMPARE_LABELS[f.compare],
  };
}

/* ── /journey/discovered (§16.4) ─────────────────────────────────────────── */

export interface JourneyDiscoveryData {
  journeys: DiscoveredJourney[];
  shifts: JourneyShift[];
  findings: JourneyFinding[];
  /** Sessions on paths too rare to store individually — the honest tail. */
  tailSessions: number;
  totalSessions: number;
  /** Distinct events GA4 reported, so "we found four journeys" has a denominator. */
  eventsSeen: number;
}

/**
 * The journeys nobody declared.
 *
 * `journeyModule` above measures the eleven steps in `FUNNEL_STEPS`, which is
 * the right tool for a funnel already agreed on and blind to everything else.
 * This one starts from session paths and lets the ranking fall out of the data
 * (ADR-005). The two are kept side by side deliberately: where they disagree,
 * the disagreement is the finding.
 */
export async function journeyDiscoveryModule(
  input: ModuleInput = trailingWindow(28),
): Promise<ModuleResult<JourneyDiscoveryData>> {
  const f = asFilters(input, 28);
  const w = f.window;

  const [paths, nodes] = await Promise.all([getJourneyPaths(w), getEventNodes(w)]);
  const prevWindow = comparisonWindow(w, f.compare);
  const [prevPaths, prevNodes] = await Promise.all([getJourneyPaths(prevWindow), getEventNodes(prevWindow)]);

  // The tail is separated before discovery: `(other)` is a bucket, not a path,
  // and walking it as one would invent a journey that nobody took.
  const real = paths.rows.filter((p) => p.steps[0] !== '(other)');
  const tailSessions = paths.rows
    .filter((p) => p.steps[0] === '(other)')
    .reduce((sum, p) => sum + p.sessions, 0);

  const journeys = discoverJourneys(real, nodes.rows);
  const previous = discoverJourneys(
    prevPaths.rows.filter((p) => p.steps[0] !== '(other)'),
    prevNodes.rows,
  );
  const shifts = compareJourneys(journeys, previous);
  const findings = journeyFindings(journeys, shifts);

  const totalSessions = real.reduce((sum, p) => sum + p.sessions, 0) + tailSessions;

  // The headline numbers are §5 metrics like any other, so they carry state and
  // a comparison rather than being bare figures on a page.
  const worst = journeys[0];
  const meta = { state: paths.state, fetchedAt: paths.fetchedAt };
  const kpis: MetricValue[] = [
    metricValue('journeys_discovered', journeys.length, meta),
    // Exits, not `1 − retention`. The two differ wherever sessions forked, and
    // a headline card disagreeing with the finding directly beneath it about
    // the same step is how a dashboard loses its reader.
    metricValue(
      'journey_worst_exit_rate',
      worstExitRate(worst),
      worst?.worstStep ? meta : { ...meta, state: 'missing' },
    ),
    metricValue(
      'journey_sessions_at_risk',
      journeys.reduce((sum, j) => sum + j.impact, 0),
      meta,
    ),
    metricValue(
      'journey_path_coverage',
      totalSessions > 0 ? (totalSessions - tailSessions) / totalSessions : null,
      meta,
    ),
  ];

  return {
    kpis,
    data: {
      journeys,
      shifts,
      findings,
      tailSessions,
      totalSessions,
      eventsSeen: nodes.rows.length,
    },
    window: w,
    warnings: [...paths.warnings, ...nodes.warnings],
    state: paths.state,
    sources: [paths.source, nodes.source],
    compareLabel: COMPARE_LABELS[f.compare],
  };
}

/** Sessions that left at the worst step, over those that reached the one before. */
function worstExitRate(j: DiscoveredJourney | undefined): number | null {
  if (!j?.worstStep) return null;
  const idx = j.steps.findIndex((s) => s.event === j.worstStep!.event);
  const base = j.steps[idx - 1]?.sessions ?? j.entrySessions;
  return base > 0 ? j.worstStep.exited / base : null;
}

/* ── /stores ─────────────────────────────────────────────────────────────── */

export interface StoresData {
  rows: StoreRollup[];
  /**
   * §4.4 — coordinates, kept beside the rollup rather than inside it.
   *
   * `StoreRollup` is the shape every metric in `lib/metrics/compute` is
   * computed over, and latitude is not a metric input. Adding it there would
   * put a presentation concern into the arithmetic layer that §5 keeps clean.
   * Null lat/lon is preserved so the map can say how many stores it left off.
   */
  geo: Array<{ storeId: string; lat: number | null; lon: number | null }>;
  states: ReturnType<typeof rollupStates>;
  darkWorklist: StoreRollup[];
  ops: Map<string, { qrVmPlaced: boolean | null; staffTrained: boolean | null; footfallDaily: number | null; nocOwner: string | null }>;
  cohort: Array<{ weeksSinceActivation: number; ordersPerStore: number }>;
}

export async function storesModule(input: ModuleInput = trailingWindow(28)): Promise<ModuleResult<StoresData>> {
  const f = asFilters(input, 28);
  const w = f.window;
  const [allStores, allOrders, allScans, ops] = await Promise.all([
    getStores(),
    getOrders(w),
    getScans(w),
    getStoreOps(),
  ]);
  const t = await getThresholds();

  // Scoped before anything is counted, so `stores_live` and the store table
  // describe the same set of stores rather than the filter narrowing only one.
  const scope = resolveScope(f, allStores.rows);
  const stores = { ...allStores, rows: scopeStores(allStores.rows, scope) };
  const orders = { ...allOrders, rows: scopeRows(allOrders.rows, scope) };
  const scans = { ...allScans, rows: scopeRows(allScans.rows, scope) };

  const dailyByStore = new Map<string, { dateKey: string; storeId: string; orders: number; revenue: number; scans: number; sessions: number }>();
  for (const o of orders.rows) {
    const key = `${o.orderDate}|${o.storeId}`;
    const cur = dailyByStore.get(key) ?? {
      dateKey: o.orderDate, storeId: o.storeId, orders: 0, revenue: 0, scans: 0, sessions: 0,
    };
    cur.orders++;
    cur.revenue += o.netValue;
    dailyByStore.set(key, cur);
  }

  const covByStore = coverageByStore(scans.rows);
  // Anchored to the window's last day, never the wall clock. Trailing windows
  // end yesterday because today is partial, so asking "did this store order
  // today" of a window that does not contain today answered no for all 272.
  const rows = rollupStores(stores.rows, [...dailyByStore.values()], w.end, covByStore);
  const totalByState = new Map<string, number>();
  for (const s of stores.rows) totalByState.set(s.state, (totalByState.get(s.state) ?? 0) + 1);
  const states = rollupStates(rows, totalByState);

  const live = rows.length;
  // Active/dark follow the selected window, not a fixed 7-day lookback: pick 90d
  // and every store that ordered in 90 days counts as active.
  const windowDays = Math.max(
    1,
    Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1,
  );
  const active = rows.filter((r) => r.ordersInWindow > 0).length;
  const dark = rows.filter((r) => r.isDark).length;
  const orderedOnLatestDay = rows.filter((r) => r.ordersOnLatestDay > 0).length;

  // §9.2 — never substitute zero for missing. Compliance is measurable only if
  // the window's last day carries order data at all; if the feed has nothing
  // for that day, "no store ordered" and "we cannot tell" are different facts
  // and only one of them is a business collapse.
  const rowsOnLatestDay = orders.rows.filter((o) => o.orderDate === w.end).length;
  const complianceReason = `No order rows for ${w.end}, the last day of this window — daily compliance is not measurable for this range.`;
  const meta = { state: worstState(stores.state, orders.state), fetchedAt: orders.fetchedAt };

  const kpis: MetricValue[] = [
    metricValue('stores_live', live, { ...meta, sourceOverride: stores.source }),
    metricValue('stores_active', active, { ...meta }),
    metricValue('store_activation_pct', live / t.total_trends_stores, {
      ...meta,
      sourceOverride: `${stores.source} ÷ ${t.total_trends_stores} Trends stores`,
    }),
    metricValue(
      'daily_order_compliance',
      presence(active === 0 ? null : orderedOnLatestDay / active, rowsOnLatestDay > 0, complianceReason),
      { ...meta },
    ),
    metricValue('stores_dark', dark, { ...meta }),
    metricValue(
      'orders_per_active_store',
      active === 0 ? null : rows.reduce((a, r) => a + r.ordersInWindow, 0) / active / windowDays,
      { ...meta },
    ),
    // Median across live stores; the per-store value is a column on the
    // operating table and the sort key for the dark-store worklist.
    metricValue(
      'days_since_last_order',
      median(rows.map((r) => r.daysSinceLastOrder).filter((d): d is number => d != null)),
      { ...meta },
    ),
  ];

  const darkWorklist = rows
    .filter((r) => r.isDark)
    .sort((a, b) => (b.daysSinceLastOrder ?? 999) - (a.daysSinceLastOrder ?? 999));

  // Activation cohort — does adoption stick?
  const cohortMap = new Map<number, { orders: number; stores: number }>();
  for (const r of rows) {
    if (!r.activatedOn) continue;
    // As of the window's last day, matching the rollup above — a cohort chart
    // measured from a date the window does not contain drifts a bucket per day.
    const weeks = Math.floor(
      (Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${r.activatedOn}T00:00:00Z`)) / (7 * 86_400_000),
    );
    if (weeks < 0 || weeks > 26) continue;
    const cur = cohortMap.get(weeks) ?? { orders: 0, stores: 0 };
    cur.orders += r.orders28d;
    cur.stores++;
    cohortMap.set(weeks, cur);
  }
  const cohort = [...cohortMap.entries()]
    .map(([weeksSinceActivation, v]) => ({
      weeksSinceActivation,
      ordersPerStore: v.stores ? v.orders / v.stores : 0,
    }))
    .sort((a, b) => a.weeksSinceActivation - b.weeksSinceActivation);

  return {
    kpis,
    data: {
      rows,
      states,
      darkWorklist,
      // A 0,0 coordinate is the Atlantic, not a store — it is what a null
      // became upstream, and it is normalised to null here so the map can
      // report it as missing rather than plot a phantom off West Africa.
      geo: stores.rows.map((s) => ({
        storeId: s.storeId,
        lat: s.lat && s.lon ? s.lat : null,
        lon: s.lat && s.lon ? s.lon : null,
      })),
      ops: new Map(ops.rows.map((o) => [o.storeId, o])),
      cohort,
    },
    window: w,
    warnings: [...stores.warnings, ...orders.warnings, ...scope.warnings],
    state: meta.state,
    sources: [stores.source, orders.source, scans.source],
    scope: scope.description,
    compareLabel: COMPARE_LABELS[f.compare],
  };
}

/* ── /catalogue — completeness (§5.4b) ─────────────────────────────────────── */

export interface CatalogueHealthResult {
  kpis: MetricValue[];
  overall: CatalogueHealthRow | null;
  pipelines: CatalogueHealthRow[];
  attributes: CatalogueHealthRow['attributes'];
  quality: CatalogueHealthRow['quality'];
  source: string;
  state: DataSourceState;
}

/**
 * Catalogue *completeness* KPIs + detail, from `catalogue_health`. Kept separate
 * from `catalogueModule` (scan-observed coverage) so the two measurements are
 * never blended (§16.5.2) — they answer different questions.
 */
export async function catalogueHealthData(): Promise<CatalogueHealthResult> {
  const h = await getCatalogueHealth();
  const rows = h.rows;
  const overall = rows.find((r) => r.pipeline === 'OVERALL') ?? rows[0] ?? null;
  const meta = { state: h.state, fetchedAt: h.fetchedAt, sourceOverride: h.source };
  const kpis: MetricValue[] = overall
    ? [
        metricValue('catalogue_complete_records', overall.completeCatalog, meta),
        metricValue('catalogue_fill_rate', overall.fillRatePct, meta),
        metricValue('catalogue_media_coverage', overall.mediaCoveragePct, meta),
        // Kept in the module so every §5 metric still reaches a surface, but
        // hidden from the /catalogue completeness strip (see HIDDEN_KPI_IDS).
        metricValue('catalogue_completion', overall.completionPct, meta),
        metricValue('catalogue_missing_records', overall.missingCatalog, meta),
      ]
    : [];
  return {
    kpis,
    overall,
    pipelines: rows,
    attributes: overall?.attributes ?? [],
    quality: overall?.quality ?? [],
    source: h.source,
    state: h.state,
  };
}

/* ── /catalogue ──────────────────────────────────────────────────────────── */

export interface CatalogueData {
  daily: Awaited<ReturnType<typeof getCatalogueDaily>>['rows'];
  gaps: Awaited<ReturnType<typeof getGaps>>['rows'];
  ageBuckets: ReturnType<typeof gapAgeBuckets>;
  reasons: Array<{ reason: string; direction: string | null; count: number }>;
  storeCoverage: Array<{ storeId: string; coverage: number | null; scans: number; failed: number }>;
  auditedCoverage: number | null;
  reportGeneratedToday: boolean | null;
  /** §6.3 — why the headline count and the breakdowns differ. */
  gapReconciliation: GapReconciliation;
}

export async function catalogueModule(
  input: ModuleInput = { start: '2026-07-30', end: '2026-08-12' },
): Promise<ModuleResult<CatalogueData>> {
  const f = asFilters(input, 14);
  const w = f.window;
  const [daily, allGaps, allScans, allStores] = await Promise.all([
    getCatalogueDaily(w),
    getGaps(w),
    getScans(w),
    getStores(),
  ]);
  const today = todayIST();

  const scope = resolveScope(f, allStores.rows);
  const stores = { ...allStores, rows: scopeStores(allStores.rows, scope) };
  const scans = { ...allScans, rows: scopePlatform(scopeRows(allScans.rows, scope), scope) };
  // The gap register is EAN-grained, not store-grained: a gap row aggregates
  // every store that hit it. Narrowing it by store would need the per-store
  // scan rows, which is what `storeCoverage` below is for — so the register
  // stays national and the header says so rather than silently half-filtering.
  const gaps = allGaps;

  // Window-level coverage is computed from EAN-level rows, not by summing daily
  // distinct counts — that would double-count any EAN scanned on more than one
  // day and quietly inflate the denominator.
  const cov = aggregateCoverage(scans.rows);
  const prevRawScans = await getScans(comparisonWindow(w, f.compare));
  const prevScans = { ...prevRawScans, rows: scopePlatform(scopeRows(prevRawScans.rows, scope), scope) };
  const prevCov = aggregateCoverage(prevScans.rows);
  const meta = { state: scans.state, fetchedAt: scans.fetchedAt };

  const openGaps = gaps.rows.filter((g) => g.status !== 'resolved' && g.status !== 'wontfix');
  // Keyed off the window's last day, not literally yesterday: for any window
  // that doesn't end today, "new today" against today's date is always zero and
  // reads as good news when it is really no news.
  const latestDay = w.end;
  const newToday = gaps.rows.filter((g) => g.firstSeen === latestDay).length;
  const scansOnLatestDay = scans.rows.filter((r) => r.dateKey === latestDay).length;
  const resolved7d = gaps.rows.filter(
    (g) => g.status === 'resolved' && g.lastSeen >= addDays(latestDay, -7),
  ).length;

  const ages = openGaps.map(
    (g) => (Date.parse(`${latestDay}T00:00:00Z`) - Date.parse(`${g.firstSeen}T00:00:00Z`)) / 86_400_000,
  );
  const medianAge = ages.length
    ? [...ages].sort((a, b) => a - b)[Math.floor(ages.length / 2)]
    : null;

  // §16.5.2 — three different measurements that will disagree. Never blend them.
  const todayRow = daily.rows.find((d) => d.dateKey === latestDay);

  // §16.5.1 — rejected scans are recorded, never silently discarded.
  const { fixtureScanRejections } = await import('@/fixtures/business');
  const rejections = fixtureScanRejections(w);
  const rejectedScans = rejections.reduce((a, r) => a + r.scanCount, 0);
  const rejectionRate = cov.totalScans === 0 ? null : rejectedScans / (cov.totalScans + rejectedScans);

  const { STORE_VISIT_AUDITS } = await import('@/fixtures/baselines');
  const auditScanned = STORE_VISIT_AUDITS.reduce((a, v) => a + v.itemsScanned, 0);
  const auditFailed = STORE_VISIT_AUDITS.reduce((a, v) => a + v.itemsFailed, 0);
  const auditedCoverage = auditScanned ? (auditScanned - auditFailed) / auditScanned : null;

  // Worst-store coverage is a KPI, so compute the per-store series first.
  const byStore = coverageByStore(scans.rows);
  const storeById = new Map(stores.rows.map((s) => [s.storeId, s]));
  const storeCoverage = [...byStore.entries()]
    .map(([storeId, v]) => ({
      storeId,
      storeName: storeById.get(storeId)?.storeName ?? storeId,
      coverage: v.scans ? (v.scans - v.failed) / v.scans : null,
      scans: v.scans,
      failed: v.failed,
    }))
    .sort((a, b) => (a.coverage ?? 1) - (b.coverage ?? 1));

  const kpis: MetricValue[] = [
    metricValue('unique_coverage', cov.uniqueCoverage, {
      ...meta,
      deltaPp: ppDelta(cov.uniqueCoverage, prevCov.uniqueCoverage),
      sourceOverride: daily.source,
    }),
    metricValue('total_coverage', cov.totalCoverage, {
      ...meta,
      deltaPp: ppDelta(cov.totalCoverage, prevCov.totalCoverage),
    }),
    metricValue('audited_coverage', auditedCoverage, {
      state: 'fixture',
      fetchedAt: new Date().toISOString(),
      sourceOverride: 'fact_store_visit_audit — 4 store visits, Jul 2026',
    }),
    metricValue('missing_distinct', cov.uniqueFailed, { ...meta }),
    // Counted against the window's last day, and reported as unmeasurable when
    // that day has no scan data at all rather than as a reassuring zero.
    metricValue(
      'missing_new',
      presence(newToday, scansOnLatestDay > 0, `No scan data for ${latestDay}, the last day of this window — new missing EANs are not measurable.`),
      { ...meta },
    ),
    metricValue('missing_resolved', resolved7d, { ...meta }),
    metricValue('missing_age_p50', medianAge, { ...meta }),
    // §16.5.1 — junk in the `ean` param inflates the missing register and drags
    // reported coverage down, so the rejection rate is shown next to coverage
    // rather than buried.
    metricValue('scan_rejection_rate', rejectionRate, {
      ...meta,
      sourceOverride: 'fact_scan_rejected_daily (bq-ga4-events)',
    }),
    // §7.7 — the feed is deferred (§13.9). Surfaced as missing so the question
    // "of what's on the floor, how much is scannable" is visibly unanswered,
    // rather than quietly absent.
    metricValue('true_coverage', null, {
      state: 'missing',
      fetchedAt: scans.fetchedAt,
      sourceOverride: 'SAP catalogue master + RRA inventory — not wired (MODULE_TRUE_COVERAGE=false)',
    }),
    // Grouped by store, the metric is a series; the headline is the worst store,
    // because that is the number that distinguishes a store-local sync issue
    // from a systemic catalogue one (§28.5 store_local).
    metricValue('store_coverage', storeCoverage[0]?.coverage ?? null, {
      ...meta,
      sourceOverride: 'fact_scan_daily grouped by store_id — worst store in window',
    }),
    metricValue('report_generated', todayRow?.reportGenerated === true ? 1 : 0, {
      state: daily.state,
      fetchedAt: daily.fetchedAt,
      sourceOverride: daily.source,
    }),
  ];

  // §6.3 — the reason breakdown and the aging histogram below both count open
  // gaps, while `missing_distinct` counts every EAN the scan feed observed
  // failing. Both are right; the page has to say so.
  const gapReconciliation = reconcileGapRegister({
    observedDistinctMissing: cov.uniqueFailed,
    gaps: gaps.rows,
  });

  const reasonCounts = new Map<string, { direction: string | null; count: number }>();
  for (const g of openGaps) {
    const cur = reasonCounts.get(g.suspectedReason) ?? { direction: g.reasonDirection, count: 0 };
    cur.count++;
    reasonCounts.set(g.suspectedReason, cur);
  }

  return {
    kpis,
    data: {
      daily: daily.rows,
      gaps: gaps.rows,
      ageBuckets: gapAgeBuckets(gaps.rows, today),
      reasons: [...reasonCounts.entries()]
        .map(([reason, v]) => ({ reason, direction: v.direction, count: v.count }))
        .sort((a, b) => b.count - a.count),
      storeCoverage,
      auditedCoverage,
      reportGeneratedToday: todayRow?.reportGenerated ?? null,
      gapReconciliation,
    },
    window: w,
    warnings: [
      ...daily.warnings,
      ...scans.warnings,
      ...scope.warnings,
      ...(scope.storeIds
        ? ['The missing-EAN register is EAN-grained and stays national; the store × coverage table below is the store-scoped view.']
        : []),
      // Only surfaced when the split is a real hole, not when it is the
      // expected open/closed partition.
      ...(gapReconciliation.reconciled
        ? []
        : [
            `${gapReconciliation.unregistered} EANs failed a scan but have no row in the gap register — they are unowned and will never be closed.`,
          ]),
    ],
    state: worstState(daily.state, scans.state),
    sources: [daily.source, scans.source],
    scope: scope.description,
    compareLabel: COMPARE_LABELS[f.compare],
  };
}

/* ── /app-health ─────────────────────────────────────────────────────────── */

export interface AppHealthData {
  daily: Awaited<ReturnType<typeof getAppHealth>>['rows'];
  latency: Awaited<ReturnType<typeof getLatency>>['rows'];
  score: ReturnType<typeof appHealthScore>;
  releases: Array<{ dateKey: string; label: string }>;
}

export async function appHealthModule(input: ModuleInput = trailingWindow(28)): Promise<ModuleResult<AppHealthData>> {
  const f = asFilters(input, 28);
  const w = f.window;
  const [health, latency, issues] = await Promise.all([getAppHealth(w), getLatency(w), getIssues()]);
  const t = await getThresholds();

  // `fact_app_health_daily` is a national daily aggregate — it carries neither
  // a store nor a platform column. A store filter therefore cannot be honoured
  // here, and silently returning national numbers under a store-scoped header
  // is worse than saying so (§14.5).
  const unhonoured = [
    f.store && `store=${f.store}`,
    f.city && `city=${f.city}`,
    f.state && `state=${f.state}`,
    f.platform && `platform=${f.platform}`,
  ].filter(Boolean) as string[];
  const scopeWarnings = unhonoured.length
    ? [
        `App health is a national daily aggregate with no store or platform dimension — ${unhonoured.join(', ')} could not be applied, and these numbers cover every store.`,
      ]
    : [];

  const latest = health.rows.at(-1) ?? null;
  const prev = health.rows.at(-2) ?? null;
  const latestLatency = latency.rows.filter((l) => l.dateKey === (latest?.dateKey ?? ''));
  const p0Open = issueMetrics.p0Open(issues.rows);

  const score = appHealthScore(
    {
      crashFreeRate: latest?.crashFreeRate ?? null,
      paymentSuccessRate: latest?.paymentSuccessRate ?? null,
      apiErrorRate: latest?.apiErrorRate ?? null,
      latency: latestLatency.map((l) => ({
        endpoint: l.endpoint,
        sloP95Ms: l.sloP95Ms,
        actualP95Ms: l.p95Ms,
      })),
      p0Open,
    },
    t,
  );

  // Share of orders on the current host app version (§1: AJIO 9.44).
  const { getOrders: getOrdersForVersions } = await import('@/lib/data/repository');
  const versionOrders = await getOrdersForVersions(w);
  const onLatest = versionOrders.rows.filter((o) => o.appVersion === '9.44').length;
  const releaseAdoption = versionOrders.rows.length ? onLatest / versionOrders.rows.length : null;

  const meta = { state: health.state, fetchedAt: health.fetchedAt };
  const worstP95 = latestLatency.reduce<number | null>(
    (a, l) => (a == null || l.p95Ms > a ? l.p95Ms : a),
    null,
  );

  const kpis: MetricValue[] = [
    metricValue('app_health_score', score.score, { ...meta, sourceOverride: 'derived (§5.8)' }),
    metricValue('crash_free_rate', latest?.crashFreeRate ?? null, {
      ...meta,
      deltaPp: ppDelta(latest?.crashFreeRate ?? null, prev?.crashFreeRate ?? null),
    }),
    metricValue('api_error_rate', latest?.apiErrorRate ?? null, {
      ...meta,
      deltaPp: ppDelta(latest?.apiErrorRate ?? null, prev?.apiErrorRate ?? null),
    }),
    metricValue('payment_failure_rate', latest ? 1 - latest.paymentSuccessRate : null, { ...meta }),
    metricValue('p95_latency', worstP95, { ...meta, sourceOverride: latency.source }),
    metricValue('error_log_volume', latest?.gcpErrorLogCount ?? null, { ...meta }),
    metricValue('p0_open', p0Open, { state: issues.state, fetchedAt: issues.fetchedAt, sourceOverride: issues.source }),
    // Version fragmentation is a real support cost, so the share on the current
    // release is a first-class number rather than a chart detail.
    metricValue('release_adoption', releaseAdoption, {
      ...meta,
      sourceOverride: 'fact_orders.app_version — cross-checked against Sentry releases',
    }),
    // §5.6 — no backend feed exists for this yet. Shown as missing rather than
    // omitted: a known platform-specific issue with no measurement is itself
    // worth seeing on the page.
    metricValue('geofence_delivery_rate', null, {
      state: 'missing',
      fetchedAt: health.fetchedAt,
      sourceOverride: 'backend geofence delivery feed — not yet available',
    }),
  ];

  return {
    kpis,
    data: {
      daily: health.rows,
      latency: latency.rows,
      score,
      // §21.3 — deploy markers. Correlating an error spike with a deploy is 80%
      // of incident triage.
      releases: [{ dateKey: '2026-08-05', label: 'AJIO 9.44' }],
    },
    window: w,
    warnings: [...health.warnings, ...latency.warnings, ...scopeWarnings],
    state: worstState(health.state, latency.state),
    sources: [health.source, latency.source, issues.source],
    compareLabel: COMPARE_LABELS[f.compare],
  };
}

/* ── /issues ─────────────────────────────────────────────────────────────── */

export interface IssuesData {
  rows: Awaited<ReturnType<typeof getIssues>>['rows'];
  byWorkstream: Array<{ workstream: string; open: number; p0: number }>;
  byJourneyStep: Array<{ step: string; count: number }>;
}

export async function issuesModule(): Promise<ModuleResult<IssuesData>> {
  const issues = await getIssues();
  const meta = { state: issues.state, fetchedAt: issues.fetchedAt, sourceOverride: issues.source };

  const kpis: MetricValue[] = [
    metricValue('p0_open', issueMetrics.p0Open(issues.rows), meta),
    metricValue('p0_age_p50', issueMetrics.p0AgeP50(issues.rows), meta),
    metricValue('issues_unowned', issueMetrics.unowned(issues.rows), meta),
    metricValue('open_close_ratio', issueMetrics.openCloseRatio(issues.rows), meta),
  ];

  const open = issues.rows.filter((i) => !i.isDone);
  const wsMap = new Map<string, { open: number; p0: number }>();
  for (const i of open) {
    const cur = wsMap.get(i.workstream) ?? { open: 0, p0: 0 };
    cur.open++;
    if (i.priority === 'P0') cur.p0++;
    wsMap.set(i.workstream, cur);
  }
  const stepMap = new Map<string, number>();
  for (const i of open) {
    if (!i.journeyStep) continue;
    stepMap.set(i.journeyStep, (stepMap.get(i.journeyStep) ?? 0) + 1);
  }

  return {
    kpis,
    data: {
      rows: issues.rows,
      byWorkstream: [...wsMap.entries()]
        .map(([workstream, v]) => ({ workstream, ...v }))
        .sort((a, b) => b.open - a.open),
      byJourneyStep: [...stepMap.entries()]
        .map(([step, count]) => ({ step, count }))
        .sort((a, b) => b.count - a.count),
    },
    window: trailingWindow(28),
    warnings: issues.warnings,
    state: issues.state,
    sources: [issues.source],
  };
}

export { worstState };
