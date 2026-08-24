/**
 * Orders, funnel, app-health and issue fixtures.
 *
 * Shaped to the §1 baselines: ~1,360 trailing-28d orders, ~₹10–12 L e-GMV,
 * ~41–42 K active users, with weekday seasonality (retail peaks Fri–Sun) and the
 * Apr→May growth curve visible in the trend.
 */
import { BUSINESS_BASELINE, WORKSTREAMS } from './baselines';
import { FIXTURE_LIVE_STORES } from './stores';
import { gaussian, hashSeed, makeRng } from './rng';
import { dateRange, isWeekend, type DateWindow } from '@/lib/format/dates';
import { CRITICAL_ENDPOINTS, DEFAULT_THRESHOLDS } from '@/lib/db/settings';
import { PROD_AFFILIATE } from '@/lib/config/env-guard';

/* ── Orders ──────────────────────────────────────────────────────────────── */

export interface OrderRow {
  orderId: string;
  orderTs: string;
  orderDate: string;
  storeId: string;
  tenant: string;
  affiliateId: string;
  customerId: string;
  isNewCustomer: boolean;
  status: string;
  statusConfirmed: boolean;
  units: number;
  grossValue: number;
  discountAmount: number;
  couponAmount: number;
  couponCode: string | null;
  netValue: number;
  paymentMethod: string;
  appVersion: string;
  sdkVersion: string;
  platform: string;
}

/**
 * A3 — the `avis_base_view` status enum is undocumented (§13.4). This is the
 * working mapping; `statusConfirmed` records which side of it a row fell on so
 * the UI can show both figures and label the ambiguity rather than pick one.
 */
// 'handed_over_to_customer' is the real avis_base_view completed status (A3,
// confirmed against the live view 2026-08-21); the others are fixture statuses.
export const CONFIRMED_STATUSES = ['handed_over_to_customer', 'delivered', 'complete', 'confirmed', 'invoiced'];
export const UNCONFIRMED_STATUSES = ['cancelled', 'returned', 'payment_failed', 'pending'];

const PAYMENT_METHODS = ['UPI', 'Card', 'JioOnePay Wallet', 'Netbanking', 'COD'];

/** Growth ramp: April ₹3.29 L → May MTD ₹7.07 L (+115% MoM), easing after. */
function growthFactor(dateKey: string): number {
  const t = new Date(`${dateKey}T00:00:00Z`).getTime();
  const apr = Date.UTC(2026, 3, 15);
  const monthsSinceApr = (t - apr) / (30.44 * 86_400_000);
  // Logistic easing so the curve flattens rather than compounding forever.
  return 1 + 2.6 / (1 + Math.exp(-0.85 * (monthsSinceApr - 1.2)));
}

/** ~48.6 orders/day sustains the 1,360 trailing-28d baseline. */
const BASE_ORDERS_PER_DAY = BUSINESS_BASELINE.trailing28dOrders / 28;

export function fixtureOrders(window: DateWindow): OrderRow[] {
  const out: OrderRow[] = [];
  for (const dateKey of dateRange(window)) {
    const rng = makeRng(hashSeed(`orders:${dateKey}`));
    const seasonal = isWeekend(dateKey) ? 1.34 : 0.9;
    const noise = 0.86 + rng() * 0.3;
    // growthFactor is normalised against "now" so a trailing-28d window lands on
    // the baseline rather than on the ramp's endpoint.
    const g = growthFactor(dateKey) / growthFactor('2026-08-12');
    const n = Math.max(0, Math.round(BASE_ORDERS_PER_DAY * seasonal * noise * g));

    for (let i = 0; i < n; i++) {
      const store = FIXTURE_LIVE_STORES[Math.floor(rng() * FIXTURE_LIVE_STORES.length)];
      const isConfirmed = rng() > 0.085; // ~8.5% cancelled/returned/failed
      const status = isConfirmed
        ? CONFIRMED_STATUSES[Math.floor(rng() * CONFIRMED_STATUSES.length)]
        : UNCONFIRMED_STATUSES[Math.floor(rng() * UNCONFIRMED_STATUSES.length)];
      const units = 1 + Math.floor(rng() * 3.4); // mean ≈ 2.24 items
      // ~₹395/unit puts gross AOV near ₹880, which lands trailing-28d e-GMV in
      // the ₹10–12 L band from §1 against ~1,244 confirmed orders.
      const gross = Math.max(199, Math.round(gaussian(rng, 395 * units, 280)));
      const discount = rng() < 0.46 ? Math.round(gross * (0.05 + rng() * 0.22)) : 0;
      const hasCoupon = rng() < 0.19;
      const coupon = hasCoupon ? Math.round(gross * (0.03 + rng() * 0.09)) : 0;
      const hour = 10 + Math.floor(rng() * 11); // store hours, IST
      out.push({
        orderId: `CMP${dateKey.replace(/-/g, '')}${String(i).padStart(4, '0')}`,
        orderTs: `${dateKey}T${String(hour).padStart(2, '0')}:${String(Math.floor(rng() * 60)).padStart(2, '0')}:00+05:30`,
        orderDate: dateKey,
        storeId: store.storeId,
        tenant: 'trends',
        affiliateId: PROD_AFFILIATE,
        // §27.4 — already hashed. The fixture never carries a plausible real id.
        customerId: `c_${(hashSeed(`cust:${Math.floor(rng() * 9000)}`) >>> 0).toString(16)}`,
        isNewCustomer: rng() < 0.62,
        status,
        statusConfirmed: isConfirmed,
        units,
        grossValue: gross,
        discountAmount: discount,
        couponAmount: coupon,
        couponCode: hasCoupon ? `TRENDS${100 + Math.floor(rng() * 800)}` : null,
        netValue: Math.max(0, gross - discount - coupon),
        paymentMethod: PAYMENT_METHODS[Math.floor(rng() * PAYMENT_METHODS.length)],
        appVersion: rng() < 0.82 ? '9.44' : '9.43',
        sdkVersion: rng() < 0.78 ? '1.3.6' : '1.2.9',
        platform: rng() < 0.78 ? 'Android' : 'iOS',
      });
    }
  }
  return out;
}

/* ── Funnel (§5.2) ───────────────────────────────────────────────────────── */

export interface FunnelStepDef {
  step: string;
  /**
   * The GA4 `event_name` this step matches, when it differs from `step`.
   * Companion fires custom event names (e.g. `payment_success`), so the internal
   * step key stays stable for the metric layer while the connector matches the
   * real event.
   */
  eventName?: string;
  label: string;
  order: number;
  /** Conversion from the previous step. */
  ratio: number;
  /**
   * A6 — no invoice/de-tag event has ever been confirmed, and it is likely not
   * instrumented. It renders as a hatched "not instrumented" step, never as a
   * zero (§16.9).
   */
  instrumented: boolean;
  /** Whether §5.2 lists the event name as confirmed or still to verify. */
  confirmed: 'confirmed' | 'verify' | 'ga4_standard';
}

export const FUNNEL_STEPS: FunnelStepDef[] = [
  { step: 'session_start', label: 'Session start', order: 1, ratio: 1, instrumented: true, confirmed: 'ga4_standard' },
  { step: 'scanner_open', label: 'Scanner open', order: 2, ratio: 0.42, instrumented: true, confirmed: 'verify' },
  { step: 'scan_attempt', label: 'Scan attempt', order: 3, ratio: 0.83, instrumented: true, confirmed: 'confirmed' },
  { step: 'scan_success', label: 'Scan success', order: 4, ratio: 0.94, instrumented: true, confirmed: 'confirmed' },
  { step: 'view_item', label: 'Product viewed', order: 5, ratio: 0.88, instrumented: true, confirmed: 'verify' },
  { step: 'add_to_cart', label: 'Added to bag', order: 6, ratio: 0.31, instrumented: true, confirmed: 'verify' },
  { step: 'view_cart', label: 'Cart viewed', order: 7, ratio: 0.72, instrumented: true, confirmed: 'verify' },
  { step: 'begin_checkout', label: 'Checkout begun', order: 8, ratio: 0.63, instrumented: true, confirmed: 'verify' },
  { step: 'add_payment_info', label: 'Payment info added', order: 9, ratio: 0.78, instrumented: true, confirmed: 'verify' },
  // Companion fires `payment_success` (verified against analytics_524294430),
  // not the GA4-standard `purchase` event. The funnel ends here.
  { step: 'purchase', eventName: 'payment_success', label: 'Payment success', order: 10, ratio: 0.9, instrumented: true, confirmed: 'confirmed' },
];

export interface FunnelRow {
  dateKey: string;
  storeId: string;
  platform: string;
  appVersion: string;
  step: string;
  stepOrder: number;
  eventCount: number;
  sessionCount: number;
  userCount: number;
  isInstrumented: boolean;
}

const BASE_SESSIONS_PER_DAY = 1700;

export function fixtureFunnel(window: DateWindow): FunnelRow[] {
  const out: FunnelRow[] = [];
  for (const dateKey of dateRange(window)) {
    const rng = makeRng(hashSeed(`funnel:${dateKey}`));
    const seasonal = isWeekend(dateKey) ? 1.31 : 0.92;
    const g = growthFactor(dateKey) / growthFactor('2026-08-12');
    const sessions = Math.round(BASE_SESSIONS_PER_DAY * seasonal * (0.9 + rng() * 0.2) * g);

    for (const platform of ['Android', 'iOS'] as const) {
      const share = platform === 'Android' ? 0.78 : 0.22;
      let count = Math.round(sessions * share);
      for (const def of FUNNEL_STEPS) {
        const jitter = 0.95 + rng() * 0.1;
        count = def.order === 1 ? count : Math.round(count * def.ratio * jitter);
        out.push({
          dateKey,
          storeId: '',
          platform,
          appVersion: '9.44',
          step: def.step,
          stepOrder: def.order,
          // §16.9 — a missing event writes zero *with* is_instrumented = false,
          // so the UI can tell "nobody did this" from "we never measured it".
          eventCount: def.instrumented ? count : 0,
          sessionCount: def.instrumented ? Math.round(count * 0.88) : 0,
          userCount: def.instrumented ? Math.round(count * 0.79) : 0,
          isInstrumented: def.instrumented,
        });
      }
    }
  }
  return out;
}

/* ── App health (§5.6) ───────────────────────────────────────────────────── */

export interface AppHealthRow {
  dateKey: string;
  sessions: number;
  crashedSessions: number;
  crashFreeRate: number;
  sentryErrorCount: number;
  apiCallCount: number;
  apiErrorCount: number;
  apiErrorRate: number;
  paymentAttempts: number;
  paymentSuccesses: number;
  paymentSuccessRate: number;
  gcpErrorLogCount: number;
}

export function fixtureAppHealth(window: DateWindow): AppHealthRow[] {
  return dateRange(window).map((dateKey) => {
    const rng = makeRng(hashSeed(`health:${dateKey}`));
    const sessions = Math.round(BASE_SESSIONS_PER_DAY * (isWeekend(dateKey) ? 1.31 : 0.92) * (0.9 + rng() * 0.2));
    // A release on 5 Aug regresses crash-free — the release_regression RCA rule
    // has something real to find.
    const postRelease = dateKey >= '2026-08-05' && dateKey <= '2026-08-08';
    const crashFree = postRelease ? 0.986 + rng() * 0.004 : 0.9935 + rng() * 0.005;
    const crashed = Math.round(sessions * (1 - crashFree));
    const apiCalls = sessions * (18 + Math.floor(rng() * 9));
    const apiErrorRate = (postRelease ? 0.035 : 0.019) + rng() * 0.008;
    const paymentAttempts = Math.round(sessions * 0.032);
    const paymentSuccessRate = 0.915 + rng() * 0.05;
    return {
      dateKey,
      sessions,
      crashedSessions: crashed,
      crashFreeRate: crashFree,
      sentryErrorCount: Math.round(apiCalls * apiErrorRate * 0.14),
      apiCallCount: apiCalls,
      apiErrorCount: Math.round(apiCalls * apiErrorRate),
      apiErrorRate,
      paymentAttempts,
      paymentSuccesses: Math.round(paymentAttempts * paymentSuccessRate),
      paymentSuccessRate,
      gcpErrorLogCount: Math.round(apiCalls * apiErrorRate * 0.42),
    };
  });
}

export interface LatencyRow {
  dateKey: string;
  endpoint: string;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  callCount: number;
  errorCount: number;
  sloP95Ms: number;
  /** A10 — placeholders must not drive alerts (§25). */
  sloConfirmed: boolean;
  source: 'real_user' | 'synthetic';
}

export function fixtureLatency(window: DateWindow): LatencyRow[] {
  const out: LatencyRow[] = [];
  for (const dateKey of dateRange(window)) {
    for (const ep of CRITICAL_ENDPOINTS) {
      const rng = makeRng(hashSeed(`lat:${dateKey}:${ep.id}`));
      const slo = DEFAULT_THRESHOLDS.slo_p95_ms[ep.id];
      // apply_promotion is the known problem area on 5–10 item carts — it sits
      // over its (placeholder) SLO, which is exactly the rpos_dependency case.
      const pressure = ep.id === 'apply_promotion' ? 1.28 : 0.62 + rng() * 0.22;
      const p50 = Math.round(slo * pressure * 0.42);
      const p90 = Math.round(slo * pressure * 0.78);
      const p95 = Math.round(slo * pressure);
      const p99 = Math.round(slo * pressure * 1.72);
      const calls = 4000 + Math.floor(rng() * 9000);
      out.push({
        dateKey,
        endpoint: ep.id,
        p50Ms: p50,
        p90Ms: p90,
        p95Ms: p95,
        p99Ms: p99,
        callCount: calls,
        errorCount: Math.round(calls * (0.004 + rng() * 0.02)),
        sloP95Ms: slo,
        sloConfirmed: DEFAULT_THRESHOLDS.slo_confirmed[ep.id] ?? false,
        source: 'real_user',
      });
    }
  }
  return out;
}

/* ── Issues (§5.7) ───────────────────────────────────────────────────────── */

export interface IssueRow {
  issueKey: string;
  source: 'jira' | 'slack_noc' | 'tasks_sheet';
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  status: string;
  /** From the tracker's done category, not a literal status-name match. */
  isDone: boolean;
  workstream: string;
  journeyStep: string | null;
  storeCode: string | null;
  assignee: string | null;
  createdAt: string;
  resolvedAt: string | null;
  url: string;
}

/** Keys known to be in flight (§22.1). */
const KNOWN_KEYS = [
  'NI-1726', 'NI-1778', 'NI-1779', 'NI-1780', 'NI-1798', 'NI-1823',
  'NI-1825', 'NI-2200', 'NI-2349', 'NI-2350', 'NI-2376', 'NI-2425',
];

const ISSUE_TITLES: Array<[string, string, string]> = [
  ['Apply promotion times out on 5–10 item carts', 'Payments & Coupons', 'begin_checkout'],
  ['Failed-scan GTM event not firing', 'Analytics & Insights', 'scan_attempt'],
  ['De-tag confirmation screen blank on iOS', 'De-tag', 'invoice_detag'],
  ['Geofence notification not delivered on Android 14', 'Location & Geofencing', 'session_start'],
  ['createInvoice returns 502 intermittently', 'Platform & Infra', 'purchase'],
  ['Size Finder returns no result for valid EAN', 'Scan & Catalogue', 'view_item'],
  ['Cart total mismatch after coupon removal', 'Payments & Coupons', 'view_cart'],
  ['QR poster missing at store', 'Store Ops', null as unknown as string],
  ['Session expires mid-checkout', 'Security', 'add_payment_info'],
  ['Playwright suite flaky on Create Order', 'QA & Automation', 'purchase'],
  ['PDP image not loading on slow network', 'UI/UX', 'view_item'],
  ['Scan returns not_found for in-stock article', 'Scan & Catalogue', 'scan_attempt'],
];

const ASSIGNEES = ['Rakesh Yadav', 'Prince Chaudhary', 'Bhagyesh Punalekar', 'Omkar Gavhane', null];

export function fixtureIssues(): IssueRow[] {
  const out: IssueRow[] = [];
  const now = Date.parse('2026-08-13T09:00:00+05:30');

  for (let i = 0; i < 46; i++) {
    const rng = makeRng(hashSeed(`issue:${i}`));
    const [title, workstream, journeyStep] = ISSUE_TITLES[i % ISSUE_TITLES.length];
    const key = i < KNOWN_KEYS.length ? KNOWN_KEYS[i] : `NI-${2430 + i}`;
    const priorityRoll = rng();
    const priority = priorityRoll < 0.09 ? 'P0' : priorityRoll < 0.34 ? 'P1' : priorityRoll < 0.72 ? 'P2' : 'P3';
    const ageDays = Math.floor(rng() * 54);
    const createdAt = new Date(now - ageDays * 86_400_000).toISOString();
    const resolved = rng() < 0.44;
    out.push({
      issueKey: key,
      source: i % 9 === 0 ? 'slack_noc' : i % 7 === 0 ? 'tasks_sheet' : 'jira',
      title,
      priority: priority as IssueRow['priority'],
      status: resolved ? 'Done' : rng() < 0.5 ? 'In Progress' : 'To Do',
      isDone: resolved,
      workstream: WORKSTREAMS.includes(workstream as (typeof WORKSTREAMS)[number])
        ? workstream
        : 'Platform & Infra',
      journeyStep: journeyStep ?? null,
      storeCode: workstream === 'Store Ops' ? FIXTURE_LIVE_STORES[i % 200].storeCode : null,
      assignee: ASSIGNEES[Math.floor(rng() * ASSIGNEES.length)],
      createdAt,
      resolvedAt: resolved ? new Date(now - Math.floor(ageDays / 2) * 86_400_000).toISOString() : null,
      url: `https://gofynd.atlassian.net/browse/${key}`,
    });
  }
  return out;
}

/**
 * §16.5.1 — rejected scan values per day. Real production data carries junk in
 * the `ean` param (URLs, placeholders, slugs), and the rejection rate is a
 * first-class signal: a high rate is an app instrumentation bug, and it distorts
 * reported coverage in both directions.
 */
export interface ScanRejectionRow {
  dateKey: string;
  reason: string;
  scanCount: number;
  sampleValues: string[];
}

export function fixtureScanRejections(window: DateWindow): ScanRejectionRow[] {
  const REASONS: Array<[string, number, string[]]> = [
    ['url', 0.45, ['https://www.ajio.com/p/12345', 'www.trends.in/item']],
    ['too_short', 0.22, ['12345', '9078']],
    ['non_numeric', 0.16, ['SKU-ABC-123']],
    ['placeholder', 0.1, ['0000000000000']],
    ['too_long', 0.07, ['123456789012345678']],
  ];
  const out: ScanRejectionRow[] = [];
  for (const dateKey of dateRange(window)) {
    const rng = makeRng(hashSeed(`reject:${dateKey}`));
    // ~1.1% of scans, i.e. under the 2% warn threshold but not zero.
    const total = Math.round(140 + rng() * 90);
    for (const [reason, share, samples] of REASONS) {
      out.push({
        dateKey,
        reason,
        scanCount: Math.round(total * share),
        sampleValues: samples,
      });
    }
  }
  return out;
}

/* ── Scan Strip (§10.3) — last 90 minutes at 1-minute resolution ─────────── */

export interface ScanMinute {
  minute: string; // ISO
  scans: number;
  failures: number;
  stores: number;
}

export function fixtureScanStrip(now = Date.now()): ScanMinute[] {
  const out: ScanMinute[] = [];
  // Anchor the seed to the minute so the strip advances but stays deterministic
  // within a minute — the newest bar animates in, the rest hold still.
  const nowMin = Math.floor(now / 60_000);
  for (let i = 89; i >= 0; i--) {
    const min = nowMin - i;
    const rng = makeRng(min >>> 0);
    const d = new Date(min * 60_000);
    // IST hour drives store-hours shape: quiet overnight, busy late afternoon.
    const istHour = (d.getUTCHours() + 5 + (d.getUTCMinutes() >= 30 ? 1 : 0)) % 24;
    const openness = istHour >= 10 && istHour <= 21 ? 1 : istHour >= 22 || istHour <= 8 ? 0.06 : 0.4;
    const peak = 1 + 0.5 * Math.sin(((istHour - 10) / 11) * Math.PI);
    const scans = Math.max(0, Math.round(gaussian(rng, 34 * openness * peak, 9 * openness)));
    const failureRate = 0.045 + rng() * 0.05;
    // Stochastic rounding rather than Math.round: at overnight volumes a plain
    // round sends every minute's failures to zero, which would hide the red
    // ticks that are half of what the strip is for — and would understate the
    // failure rate rather than sampling it.
    const expectedFailures = scans * failureRate;
    const failures = Math.floor(expectedFailures) + (rng() < expectedFailures % 1 ? 1 : 0);
    out.push({
      minute: d.toISOString(),
      scans,
      failures: Math.min(scans, failures),
      stores: Math.max(0, Math.round(scans * 0.42)),
    });
  }
  return out;
}
