/**
 * §28.2 — The context builder. The single most important piece of the AI layer.
 *
 * The model receives named numbers with windows, never raw rows. Two fields do
 * unusually heavy lifting:
 *
 *  - `calendar`, because Indian retail runs on sale events and without it the
 *    model will confidently explain seasonality as an incident.
 *  - `connectorHealth`, because "the metric is missing since the pipe broke" and
 *    "the business changed" produce opposite recommendations.
 */
import type { MetricValue } from '@/lib/metrics/compute';
import type { Anomaly } from './anomaly';

export interface InsightContext {
  generatedAt: string; // ISO, IST-labelled
  window: { start: string; end: string };
  metrics: Array<{
    id: string;
    label: string;
    value: number | null;
    unit: 'count' | 'inr' | 'ratio' | 'ms' | 'score' | 'days';
    deltaVsYesterday: number | null;
    deltaVsSameWeekdayLastWeek: number | null;
    deltaVsTrailing28Median: number | null;
    zScore: number | null;
    flagged: boolean;
    state: 'live' | 'stale' | 'fixture' | 'missing' | 'not_instrumented';
  }>;
  anomalies: Array<{
    metricId: string;
    direction: 'up' | 'down';
    zScore: number | null;
    magnitude: string;
    ruleHits: string[];
  }>;
  openP0: Array<{ key: string; title: string; ageDays: number; workstream: string; owner: string | null }>;
  catalogueDeltas: {
    newMissing: number;
    resolved: number;
    topReasons: Array<{ reason: string; count: number }>;
  };
  storeSignals: {
    active: number;
    dark7d: number;
    compliancePct: number;
    topDeclining: Array<{ storeCode: string; deltaPct: number }>;
    /** State-level view, so a regional problem is visible rather than averaged away. */
    topDecliningStates: Array<{ state: string; deltaPct: number }>;
  };
  connectorHealth: Array<{ id: string; status: 'green' | 'amber' | 'red' | 'grey'; lastRun: string }>;
  calendar: {
    isSalePeriod: boolean;
    saleName: string | null;
    comparabilityWarning: string | null;
  };
}

export interface BuildContextInput {
  window: { start: string; end: string };
  metrics: MetricValue[];
  anomalies: Anomaly[];
  openP0: InsightContext['openP0'];
  catalogueDeltas: InsightContext['catalogueDeltas'];
  storeSignals: InsightContext['storeSignals'];
  connectorHealth: InsightContext['connectorHealth'];
  calendar: InsightContext['calendar'];
  zScores?: Map<string, number | null>;
  medianDeltas?: Map<string, number | null>;
}

function toContextState(s: MetricValue['state']): InsightContext['metrics'][number]['state'] {
  switch (s) {
    case 'live':
    case 'cache':
      return 'live';
    case 'stale':
      return 'stale';
    case 'fixture':
      return 'fixture';
    case 'not_instrumented':
      return 'not_instrumented';
    default:
      return 'missing';
  }
}

/**
 * Round every number in the context to 4 decimals. Two reasons: an unrounded
 * float (e.g. AOV 1159.678484243537) is noise the model does not need, and its
 * 12-digit decimal tail trips the Aadhaar guard in `assertNoPii` as a false
 * positive. Integers and strings pass through unchanged.
 */
function roundDeep<T>(value: T): T {
  if (typeof value === 'number') {
    return (Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value) as T;
  }
  if (Array.isArray(value)) return value.map(roundDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)])) as T;
  }
  return value;
}

export function buildInsightContext(input: BuildContextInput): InsightContext {
  const flagged = new Set(input.anomalies.filter((a) => !a.suppressed).map((a) => a.metricId));

  return roundDeep({
    generatedAt: new Date().toISOString(),
    window: input.window,
    metrics: input.metrics.map((m) => ({
      id: m.id,
      label: m.label,
      value: m.value,
      unit: m.unit,
      deltaVsYesterday: m.deltaVsPrev ?? null,
      deltaVsSameWeekdayLastWeek: m.deltaVsSameWeekdayLastWeek ?? null,
      deltaVsTrailing28Median: input.medianDeltas?.get(m.id) ?? null,
      zScore: input.zScores?.get(m.id) ?? null,
      flagged: flagged.has(m.id),
      state: toContextState(m.state),
    })),
    anomalies: input.anomalies
      .filter((a) => !a.suppressed)
      .map((a) => ({
        metricId: a.metricId,
        direction: a.direction,
        zScore: a.zScore,
        magnitude: a.magnitude,
        ruleHits: a.ruleHits,
      })),
    openP0: input.openP0,
    catalogueDeltas: input.catalogueDeltas,
    storeSignals: input.storeSignals,
    connectorHealth: input.connectorHealth,
    calendar: input.calendar,
  });
}

/**
 * §28.7 — no PII in prompts, aggregates only. Asserted before every call rather
 * than trusted, because the cost of getting this wrong is a governance incident
 * with RIL data, not a bug.
 */
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/i, 'email address'],
  [/\b(?:\+91[-\s]?)?[6-9]\d{9}\b/, 'Indian mobile number'],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/, 'Aadhaar-like number'],
];

export function assertNoPii(payload: unknown): void {
  const json = JSON.stringify(payload);
  for (const [pattern, label] of PII_PATTERNS) {
    if (pattern.test(json)) {
      throw new Error(`Refusing to send context to the model: it contains a ${label} — see §27.4`);
    }
  }
}
