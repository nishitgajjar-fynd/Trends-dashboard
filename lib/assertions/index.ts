/**
 * §6.3 — Assertions. Mandatory.
 *
 * Every ETL run validates before it commits. This exists because
 * `avis_base_view` silently stopped reflecting new orders from 25 Jun 2026 and
 * the gap ran for roughly two weeks before anyone noticed, while the pipeline
 * reported itself as updating daily (DOPS-25241).
 *
 * On hard fail: do not overwrite the mart, keep serving the last good snapshot,
 * mark the connector red, and post to the alert channel. On warn: commit, but
 * flag the affected cards in the UI with a caution marker.
 */
import type { Assertion, AssertionContext, AssertionVerdict } from '@/lib/connectors/types';
import { minutesSince } from '@/lib/format/dates';
import { reconcileGapRegister } from '@/lib/metrics/reconcile';

/** Reads a named column off a row without requiring an index signature. */
const col = (row: unknown, name: string): unknown => (row as Record<string, unknown>)[name];

const pass = (id: string, message: string, observed?: number | string | null): AssertionVerdict => ({
  id,
  level: 'pass',
  message,
  observed,
});

/** max(column) must be within `maxLagHours` of now, else the feed has gone stale. */
export function freshness<T>(opts: {
  column: keyof T & string;
  maxLagHours: number;
  level?: 'warn' | 'fail';
}): Assertion<T> {
  const level = opts.level ?? 'fail';
  return {
    id: `freshness:${opts.column}`,
    level,
    run(rows, ctx: AssertionContext) {
      if (rows.length === 0) {
        return { id: `freshness:${opts.column}`, level, message: 'No rows to check freshness on' };
      }
      let newest = -Infinity;
      for (const r of rows) {
        const t = new Date(String(col(r, opts.column))).getTime();
        if (Number.isFinite(t) && t > newest) newest = t;
      }
      if (!Number.isFinite(newest)) {
        return { id: `freshness:${opts.column}`, level, message: `Unparseable ${opts.column}` };
      }
      // Measured against the **window end**, not `now`: a backfill of a historical
      // window is legitimately old, but the feed within that window must still be
      // current up to its end. For an incremental run window.end ≈ now, so a
      // silently-stopped feed is still caught. Clamped at 0 so a window ending
      // today (reference in the future) never reads as negative lag.
      const refMs = ctx?.window?.end
        ? Date.parse(`${ctx.window.end}T23:59:59+05:30`)
        : Date.now();
      const lagHours = Math.max(0, (refMs - newest) / 3_600_000);
      if (lagHours > opts.maxLagHours) {
        return {
          id: `freshness:${opts.column}`,
          level,
          message: `Data is ${lagHours.toFixed(1)}h stale (SLA ${opts.maxLagHours}h) — the feed may have stopped silently`,
          observed: Number(lagHours.toFixed(1)),
          expected: opts.maxLagHours,
        };
      }
      return pass(`freshness:${opts.column}`, `Fresh — ${lagHours.toFixed(1)}h lag`, Number(lagHours.toFixed(1)));
    },
  };
}

/** Row count within ±tolerance of the trailing median. Zero rows is a hard fail. */
export function rowVolume<T>(opts: {
  vsTrailingMedianDays?: number;
  tolerance: number;
  zeroIsFail?: boolean;
}): Assertion<T> {
  return {
    id: 'row_volume',
    level: 'warn',
    run(rows, ctx: AssertionContext) {
      const n = rows.length;
      if (n === 0 && opts.zeroIsFail) {
        return {
          id: 'row_volume',
          level: 'fail',
          message: 'Zero rows ingested — almost always a pipeline break, not a business event',
          observed: 0,
        };
      }
      const history = ctx.trailingRowCounts ?? [];
      if (history.length < 3) return pass('row_volume', `${n} rows (no baseline yet)`, n);
      const med = median(history);
      if (med === 0) return pass('row_volume', `${n} rows (baseline is zero)`, n);
      const deviation = Math.abs(n - med) / med;
      if (deviation > opts.tolerance) {
        return {
          id: 'row_volume',
          level: 'warn',
          message: `Row count ${n} deviates ${(deviation * 100).toFixed(0)}% from trailing median ${med}`,
          observed: n,
          expected: med,
        };
      }
      return pass('row_volume', `${n} rows, within ${(opts.tolerance * 100).toFixed(0)}% of median`, n);
    },
  };
}

export function uniqueness<T>(opts: {
  key: keyof T & string;
  level?: 'warn' | 'fail';
}): Assertion<T> {
  const level = opts.level ?? 'fail';
  return {
    id: `uniqueness:${opts.key}`,
    level,
    run(rows) {
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const r of rows) {
        const k = String(col(r, opts.key));
        if (seen.has(k)) dupes.add(k);
        seen.add(k);
      }
      if (dupes.size > 0) {
        return {
          id: `uniqueness:${opts.key}`,
          level,
          message: `${dupes.size} duplicate ${opts.key} values in window (e.g. ${[...dupes].slice(0, 3).join(', ')})`,
          observed: dupes.size,
          expected: 0,
        };
      }
      return pass(`uniqueness:${opts.key}`, `${seen.size} distinct ${opts.key}, no duplicates`, seen.size);
    },
  };
}

export function range<T>(opts: {
  column: keyof T & string;
  min?: number;
  max?: number;
  level?: 'warn' | 'fail';
  message?: string;
}): Assertion<T> {
  const level = opts.level ?? 'fail';
  const id = `range:${opts.column}:${opts.min ?? '-inf'}..${opts.max ?? 'inf'}`;
  return {
    id,
    level,
    run(rows) {
      let offenders = 0;
      let worst: number | null = null;
      for (const r of rows) {
        const v = Number(col(r, opts.column));
        if (!Number.isFinite(v)) continue;
        const below = opts.min !== undefined && v < opts.min;
        const above = opts.max !== undefined && v > opts.max;
        if (below || above) {
          offenders++;
          if (worst === null || Math.abs(v) > Math.abs(worst)) worst = v;
        }
      }
      if (offenders > 0) {
        return {
          id,
          level,
          message:
            opts.message ??
            `${offenders} rows outside range for ${opts.column} (worst ${worst})`,
          observed: worst,
        };
      }
      return pass(id, `${opts.column} within range`);
    },
  };
}

export function nullRate<T>(opts: {
  columns: (keyof T & string)[];
  max: number;
  level?: 'warn' | 'fail';
}): Assertion<T> {
  const level = opts.level ?? 'warn';
  return {
    id: `null_rate:${opts.columns.join(',')}`,
    level,
    run(rows) {
      if (rows.length === 0) return pass('null_rate', 'No rows');
      const offenders: string[] = [];
      for (const c of opts.columns) {
        const nulls = rows.filter((r) => col(r, c) == null || col(r, c) === '').length;
        const rate = nulls / rows.length;
        if (rate > opts.max) offenders.push(`${c} ${(rate * 100).toFixed(1)}%`);
      }
      if (offenders.length > 0) {
        return {
          id: `null_rate:${opts.columns.join(',')}`,
          level,
          message: `Null rate above ${(opts.max * 100).toFixed(0)}% on: ${offenders.join(', ')}`,
        };
      }
      return pass(`null_rate:${opts.columns.join(',')}`, 'Null rates within tolerance');
    },
  };
}

/** §15.5 — row-level production enforcement, not config validation. */
export function valueSet<T>(opts: {
  column: keyof T & string;
  allowed: string[];
  level?: 'warn' | 'fail';
  message?: string;
}): Assertion<T> {
  const level = opts.level ?? 'fail';
  const id = `value_set:${opts.column}`;
  return {
    id,
    level,
    run(rows) {
      const bad = new Set<string>();
      for (const r of rows) {
        const v = col(r, opts.column);
        if (v == null) continue;
        if (!opts.allowed.includes(String(v))) bad.add(String(v));
      }
      if (bad.size > 0) {
        return {
          id,
          level,
          message: opts.message ?? `Unexpected ${opts.column} values: ${[...bad].join(', ')}`,
          observed: [...bad].join(','),
          expected: opts.allowed.join(','),
        };
      }
      return pass(id, `All ${opts.column} values allowed`);
    },
  };
}

/** §18.5 — recompute a value and check it against the source's own stated figure. */
export function reconcile<T>(opts: {
  id?: string;
  computed: (rows: T[]) => number | null;
  against: (rows: T[]) => number | null;
  tolerance: number;
  level?: 'warn' | 'fail';
  message?: string;
}): Assertion<T> {
  const id = opts.id ?? 'reconcile';
  const level = opts.level ?? 'warn';
  return {
    id,
    level,
    run(rows) {
      const a = opts.computed(rows);
      const b = opts.against(rows);
      if (a == null || b == null) return pass(id, 'Nothing to reconcile');
      const diff = Math.abs(a - b);
      if (diff > opts.tolerance) {
        return {
          id,
          level,
          message:
            opts.message ??
            `Recomputed ${a.toFixed(4)} vs stated ${b.toFixed(4)} — parser or source arithmetic has drifted`,
          observed: Number(a.toFixed(4)),
          expected: Number(b.toFixed(4)),
        };
      }
      return pass(id, `Reconciled within ${opts.tolerance}`);
    },
  };
}

export function cardinality<T>(opts: {
  column: keyof T & string;
  minDistinct: number;
  level?: 'warn' | 'fail';
}): Assertion<T> {
  const level = opts.level ?? 'warn';
  const id = `cardinality:${opts.column}`;
  return {
    id,
    level,
    run(rows) {
      const distinct = new Set(rows.map((r) => String(col(r, opts.column) ?? '')).filter(Boolean));
      if (distinct.size < opts.minDistinct) {
        return {
          id,
          level,
          message: `Only ${distinct.size} distinct ${opts.column} (expected ≥ ${opts.minDistinct}) — dimension may have collapsed`,
          observed: distinct.size,
          expected: opts.minDistinct,
        };
      }
      return pass(id, `${distinct.size} distinct ${opts.column}`, distinct.size);
    },
  };
}

/** §16.5.1 — scan EAN rejection rate. A high rate is an app instrumentation bug. */
export function scanHygiene<T>(opts: {
  rate: (rows: T[]) => number;
  warnAbove: number;
  failAbove: number;
}): Assertion<T> {
  return {
    id: 'scan_hygiene',
    level: 'warn',
    run(rows) {
      const rate = opts.rate(rows);
      const msg = `Scan EAN rejection rate ${(rate * 100).toFixed(1)}% — likely app instrumentation issue, check the \`ean\` param at source`;
      if (rate > opts.failAbove) return { id: 'scan_hygiene', level: 'fail', message: msg, observed: rate };
      if (rate > opts.warnAbove) return { id: 'scan_hygiene', level: 'warn', message: msg, observed: rate };
      return pass('scan_hygiene', `Rejection rate ${(rate * 100).toFixed(1)}%`, rate);
    },
  };
}

/**
 * §6.3 — the gap register must account for every EAN the scan feed saw fail.
 *
 * The headline `missing_distinct` card and the reason/aging breakdowns count
 * different populations by design (all observed vs still open), and the page
 * discloses that split. This assertion guards the part that is *not* by design:
 * an EAN that failed a scan and never got a register row is a gap with no
 * owner, no reason and no aging clock, and it will sit there indefinitely.
 */
export function gapRegisterCoverage<T extends { status: string }>(opts: {
  observedDistinctMissing: (rows: T[], ctx: AssertionContext) => number;
  /** Rows unregistered before this trips. Small drift is a join-timing artefact. */
  tolerance?: number;
  level?: 'warn' | 'fail';
}): Assertion<T> {
  const level = opts.level ?? 'fail';
  const tolerance = opts.tolerance ?? 0;
  return {
    id: 'gap_register_coverage',
    level,
    run(rows, ctx) {
      const observed = opts.observedDistinctMissing(rows, ctx);
      const rec = reconcileGapRegister({ observedDistinctMissing: observed, gaps: rows });
      if (rec.unregistered > tolerance) {
        return {
          id: 'gap_register_coverage',
          level,
          message: `${rec.unregistered} EANs failed a scan but have no gap-register row — unowned and unaging (${rec.line})`,
          observed: rec.registered,
          expected: observed,
        };
      }
      return pass('gap_register_coverage', `Register accounts for all observed misses — ${rec.line}`, rec.registered);
    },
  };
}

/** §18.6 — did the daily report arrive at all. */
export function missingReport<T>(opts: {
  present: (rows: T[]) => boolean;
  expectedDailyBy: string;
}): Assertion<T> {
  return {
    id: 'missing_report',
    level: 'warn',
    run(rows, ctx) {
      if (opts.present(rows)) return pass('missing_report', 'Report present');
      return {
        id: 'missing_report',
        level: 'warn',
        message: `No Scan Catalog Daily Report for ${ctx.window.end} (expected by ${opts.expectedDailyBy}) — check Tatsu / upstream GA4→BQ job`,
      };
    },
  };
}

/** §16.8 — a required event has zero volume. */
export function eventPresence<T extends { step?: string; event_name?: string; eventCount?: number }>(opts: {
  required: string[];
  level?: 'warn' | 'fail';
}): Assertion<T> {
  const level = opts.level ?? 'fail';
  return {
    id: `event_presence:${opts.required.join(',')}`,
    level,
    run(rows) {
      const seen = new Set(rows.map((r) => r.step ?? r.event_name ?? ''));
      const missing = opts.required.filter((e) => !seen.has(e));
      if (missing.length > 0) {
        return {
          id: `event_presence:${opts.required.join(',')}`,
          level,
          message: `Required events absent from export: ${missing.join(', ')}`,
        };
      }
      return pass('event_presence', 'All required events present');
    },
  };
}

/**
 * §16.8 — GA4 `purchase` count vs BQ order count. They will never match exactly
 * (client-side loss, ad blockers, session expiry) but should be within ~10%. A
 * widening gap means either instrumentation broke or the order pipeline did, and
 * it is the cheapest early-warning signal available.
 */
export function crossCheck<T>(opts: {
  id: string;
  left: (rows: T[]) => number | null;
  right: () => Promise<number | null> | number | null;
  tolerance: number;
  level?: 'warn' | 'fail';
}): Assertion<T> {
  const level = opts.level ?? 'warn';
  return {
    id: opts.id,
    level,
    async run(rows) {
      const a = opts.left(rows);
      const b = await opts.right();
      if (a == null || b == null || b === 0) return pass(opts.id, 'Cross-check unavailable');
      const drift = Math.abs(a - b) / b;
      if (drift > opts.tolerance) {
        return {
          id: opts.id,
          level,
          message: `Cross-check drift ${(drift * 100).toFixed(1)}% (${a} vs ${b}) — instrumentation or order pipeline may have broken`,
          observed: a,
          expected: b,
        };
      }
      return pass(opts.id, `Cross-check within ${(opts.tolerance * 100).toFixed(0)}%`);
    },
  };
}

export function referential<T>(opts: {
  column: keyof T & string;
  against: string;
  knownKeys: () => Promise<Set<string>> | Set<string>;
  maxOrphanRate: number;
  level?: 'warn' | 'fail';
}): Assertion<T> {
  const level = opts.level ?? 'warn';
  const id = `referential:${opts.column}->${opts.against}`;
  return {
    id,
    level,
    async run(rows) {
      if (rows.length === 0) return pass(id, 'No rows');
      const known = await opts.knownKeys();
      if (known.size === 0) return pass(id, `${opts.against} not populated yet`);
      const orphans = rows.filter((r) => {
        const v = col(r, opts.column);
        return v != null && v !== '' && !known.has(String(v));
      }).length;
      const rate = orphans / rows.length;
      if (rate > opts.maxOrphanRate) {
        return {
          id,
          level,
          message: `${(rate * 100).toFixed(1)}% of rows have a ${opts.column} not in ${opts.against}`,
          observed: Number(rate.toFixed(4)),
          expected: opts.maxOrphanRate,
        };
      }
      return pass(id, `Orphan rate ${(rate * 100).toFixed(1)}%`);
    },
  };
}

export async function runAssertions<T>(
  assertions: Assertion<T>[],
  rows: T[],
  ctx: AssertionContext,
): Promise<AssertionVerdict[]> {
  const out: AssertionVerdict[] = [];
  for (const a of assertions) {
    try {
      out.push(await a.run(rows, ctx));
    } catch (e) {
      out.push({
        id: a.id,
        level: 'warn',
        message: `Assertion threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}

export function worstLevel(verdicts: AssertionVerdict[]): 'pass' | 'warn' | 'fail' {
  if (verdicts.some((v) => v.level === 'fail')) return 'fail';
  if (verdicts.some((v) => v.level === 'warn')) return 'warn';
  return 'pass';
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export { median };
