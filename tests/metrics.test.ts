/**
 * §5 — the metric contract, including the App Health Score's renormalisation
 * behaviour (§5.8) and the not-instrumented handling that keeps the funnel
 * honest (§16.9).
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateFunnel,
  appHealthScore,
  journey,
  metricValue,
  ratio,
  rollupStates,
  rollupStores,
} from '@/lib/metrics/compute';
import { DEFAULT_THRESHOLDS } from '@/lib/db/settings';
import { ALL_METRIC_IDS, getMetric, METRICS } from '@/lib/metrics/registry';
import { formatINR, formatCount, formatPct } from '@/lib/format/currency';
import { istDateKey, trailingWindow } from '@/lib/format/dates';

describe('§5 metric registry is the contract', () => {
  it('gives every metric a formula, source, grain and description', () => {
    for (const id of ALL_METRIC_IDS) {
      const m = getMetric(id)!;
      expect(m.formula, `${id} formula`).toBeTruthy();
      expect(m.source, `${id} source`).toBeTruthy();
      expect(m.grain, `${id} grain`).toBeTruthy();
      expect(m.description, `${id} description`).toBeTruthy();
    }
  });

  it('refuses to build a value for a metric that is not in §5', () => {
    // "If a metric isn't in §5, add it to §5 first, then implement."
    expect(() => metricValue('made_up_metric', 1)).toThrow(/add it to §5/);
  });

  it('carries provenance on every value', () => {
    const v = metricValue('orders', 1360, { state: 'fixture' });
    expect(v.source).toBeTruthy();
    expect(v.grain).toBeTruthy();
    expect(v.fetchedAt).toBeTruthy();
    expect(v.state).toBe('fixture');
  });

  it('labels the metrics whose definition is still ambiguous', () => {
    // A11 (Jira board filter) stays flagged on its own card. The order-status
    // ambiguity note now lives on the orders_confirmed card (explaining why it
    // equals Orders) rather than on the Orders headline, to keep the strip clean.
    expect(METRICS.p0_open.ambiguous).toBe(true);
    expect(METRICS.orders_confirmed.ambiguous).toBe(true);
    expect(METRICS.orders_confirmed.caveat).toMatch(/same as orders/i);
  });

  it('keeps the three coverage measurements permanently distinct', () => {
    // §16.5.2 — never blend or substitute these.
    expect(METRICS.unique_coverage.id).not.toBe(METRICS.audited_coverage.id);
    expect(METRICS.audited_coverage.id).not.toBe(METRICS.true_coverage.id);
    expect(METRICS.audited_coverage.description).toMatch(/shelf/i);
    expect(METRICS.true_coverage.description).toMatch(/should exist/i);
  });
});

describe('safe arithmetic', () => {
  it('returns null rather than Infinity or NaN on a zero denominator', () => {
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(NaN, 1)).toBeNull();
    expect(ratio(3, 4)).toBe(0.75);
  });
});

describe('§5.8 App Health Score', () => {
  const full = {
    crashFreeRate: 0.995,
    paymentSuccessRate: 0.97,
    apiErrorRate: 0.01,
    latency: [{ endpoint: 'cart_update', sloP95Ms: 500, actualP95Ms: 400 }],
    p0Open: 2,
  };

  it('computes a decomposable score with all five components', () => {
    const s = appHealthScore(full, DEFAULT_THRESHOLDS);
    expect(s.score).not.toBeNull();
    expect(s.renormalised).toBe(false);
    expect(s.components).toHaveLength(5);
    expect(s.components.every((c) => c.included)).toBe(true);
    expect(s.totalWeightAvailable).toBe(100);
  });

  it('renormalises weights and names the missing component (§5.8 acceptance)', () => {
    // Phase 4 acceptance: removing one component renormalises the weights and
    // the UI names what is missing.
    const withoutCrash = appHealthScore({ ...full, crashFreeRate: null }, DEFAULT_THRESHOLDS);
    expect(withoutCrash.renormalised).toBe(true);
    expect(withoutCrash.missingComponents).toContain('Crash-free sessions');
    expect(withoutCrash.totalWeightAvailable).toBe(70);
    expect(withoutCrash.score).not.toBeNull();
  });

  it('never substitutes zero for missing — that would be a false alarm', () => {
    const withoutCrash = appHealthScore({ ...full, crashFreeRate: null }, DEFAULT_THRESHOLDS);
    const withZeroCrash = appHealthScore({ ...full, crashFreeRate: 0 }, DEFAULT_THRESHOLDS);

    // Substituting zero for a missing Sentry feed drops the same healthy system
    // from amber to red, which is a monitoring gap masquerading as an incident.
    expect(withoutCrash.score!).toBeGreaterThan(withZeroCrash.score!);
    expect(withoutCrash.band).toBe('amber');
    expect(withZeroCrash.band).toBe('red');
    expect(withoutCrash.missingComponents).toContain('Crash-free sessions');
    expect(withZeroCrash.missingComponents).toHaveLength(0);
  });

  it('returns an unknown band when nothing is measurable', () => {
    const none = appHealthScore(
      { crashFreeRate: null, paymentSuccessRate: null, apiErrorRate: null, latency: [], p0Open: null },
      DEFAULT_THRESHOLDS,
    );
    expect(none.score).toBeNull();
    expect(none.band).toBe('unknown');
  });

  it('bands at ≥90 green, 75–89 amber, <75 red', () => {
    expect(appHealthScore(full, DEFAULT_THRESHOLDS).band).toBe('green');
    const bad = appHealthScore(
      { ...full, crashFreeRate: 0.6, paymentSuccessRate: 0.5, apiErrorRate: 0.2, p0Open: 20 },
      DEFAULT_THRESHOLDS,
    );
    expect(bad.band).toBe('red');
  });
});

describe('§16.9 not-instrumented is not zero', () => {
  const rows = [
    { step: 'session_start', stepOrder: 1, eventCount: 1000, sessionCount: 900, userCount: 800, isInstrumented: true },
    { step: 'add_payment_info', stepOrder: 9, eventCount: 50, sessionCount: 45, userCount: 40, isInstrumented: true },
    { step: 'purchase', stepOrder: 10, eventCount: 45, sessionCount: 44, userCount: 40, isInstrumented: true },
    { step: 'invoice_detag', stepOrder: 11, eventCount: 0, sessionCount: 0, userCount: 0, isInstrumented: false },
  ];

  it('returns null, not 0, for a rate whose step is uninstrumented', () => {
    const steps = aggregateFunnel(rows);
    // A6: the final journey step is probably invisible today. That must render
    // as a gap, never as a 0% completion rate.
    const dropoff = journey.stepDropoff(steps);
    const finalLeg = dropoff.find((d) => d.to === 'invoice_detag');
    expect(finalLeg?.conversion).toBeNull();
    expect(finalLeg?.instrumented).toBe(false);
  });

  it('still computes rates for the instrumented steps around it', () => {
    // payment_success rate is success ÷ (success + failure); `purchase` is the
    // internal key for the payment_success event.
    const steps = aggregateFunnel([
      ...rows,
      { step: 'payment_failure', stepOrder: 12, eventCount: 5, sessionCount: 5, userCount: 5, isInstrumented: true },
    ]);
    expect(journey.paymentSuccessRate(steps)).toBeCloseTo(0.9, 5); // 45 / (45 + 5)
  });

  it('treats a step as uninstrumented if any slice says so', () => {
    const mixed = aggregateFunnel([
      { step: 'purchase', stepOrder: 10, eventCount: 10, sessionCount: 10, userCount: 10, isInstrumented: true },
      { step: 'purchase', stepOrder: 10, eventCount: 0, sessionCount: 0, userCount: 0, isInstrumented: false },
    ]);
    expect(mixed[0].isInstrumented).toBe(false);
  });
});

describe('store and state rollups', () => {
  const dims = [
    { storeId: '601', storeCode: '00001', storeName: 'A', city: 'Mumbai', state: 'Maharashtra', region: 'West', companionLive: true, activatedOn: '2026-03-01' },
    { storeId: '602', storeCode: '00002', storeName: 'B', city: 'Pune', state: 'Maharashtra', region: 'West', companionLive: true, activatedOn: '2026-03-01' },
    { storeId: '603', storeCode: '00003', storeName: 'C', city: 'Delhi', state: 'Delhi', region: 'North', companionLive: true, activatedOn: '2026-03-01' },
    { storeId: '604', storeCode: '00004', storeName: 'D', city: 'Delhi', state: 'Delhi', region: 'North', companionLive: false, activatedOn: null },
  ];
  const today = '2026-08-13';
  const daily = [
    { dateKey: '2026-08-13', storeId: '601', orders: 3, revenue: 2400, scans: 40, sessions: 20 },
    { dateKey: '2026-08-01', storeId: '602', orders: 1, revenue: 800, scans: 10, sessions: 5 },
  ];

  it('excludes stores where Companion is not live', () => {
    const rows = rollupStores(dims, daily, today);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.storeId)).not.toContain('604');
  });

  it('marks a store dark when it has no orders in 7 days', () => {
    const rows = rollupStores(dims, daily, today);
    expect(rows.find((r) => r.storeId === '601')!.isDark).toBe(false);
    expect(rows.find((r) => r.storeId === '602')!.isDark).toBe(true);
    expect(rows.find((r) => r.storeId === '603')!.daysSinceLastOrder).toBeNull();
  });

  it('rolls up to state level with an estate-activation share', () => {
    const rows = rollupStores(dims, daily, today);
    const totalByState = new Map([['Maharashtra', 4], ['Delhi', 6]]);
    const states = rollupStates(rows, totalByState);
    const mh = states.find((s) => s.state === 'Maharashtra')!;
    expect(mh.storesLive).toBe(2);
    expect(mh.storesActive).toBe(1);
    expect(mh.storesDark).toBe(1);
    expect(mh.activationPct).toBeCloseTo(0.5, 5);
    expect(mh.region).toBe('West');
  });
});

describe('§27.3 Indian numbering', () => {
  it('renders lakh and crore, not millions', () => {
    expect(formatINR(1_020_000)).toBe('₹10.2 L');
    expect(formatINR(32_900_000)).toBe('₹3.29 Cr');
    expect(formatINR(329_000)).toBe('₹3.29 L');
    expect(formatINR(707_000)).toBe('₹7.07 L');
  });

  it('groups integers the Indian way', () => {
    expect(formatCount(10_200_000)).toBe('1,02,00,000');
    expect(formatCount(41_628)).toBe('41,628');
  });

  it('renders a missing value as an em dash rather than zero', () => {
    expect(formatINR(null)).toBe('—');
    expect(formatPct(null)).toBe('—');
    expect(formatCount(null)).toBe('—');
  });
});

describe('§27.2 IST is the retail day', () => {
  it('assigns a 02:00 IST instant to the IST day, not the UTC day', () => {
    // 2026-08-13T02:00+05:30 is 2026-08-12T20:30Z — a 5.5-hour boundary shift.
    expect(istDateKey('2026-08-13T02:00:00+05:30')).toBe('2026-08-13');
    expect(istDateKey('2026-08-12T20:30:00Z')).toBe('2026-08-13');
  });

  it('builds a trailing window ending yesterday', () => {
    const w = trailingWindow(28, '2026-08-13');
    expect(w.end).toBe('2026-08-12');
    expect(w.start).toBe('2026-07-16');
  });
});
