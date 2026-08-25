/**
 * §16.5.1 — EAN hygiene. Mandatory, and not optional cleanup.
 *
 * Ritu Raj flagged on 17 Jun 2026 that scan data contains random URLs in the
 * `ean` column. That is a permanent filter, not a one-off cleanup: every junk
 * value that survives into `fact_scan_daily` does two things at once — it
 * inflates the missing-EAN register with a product that never existed, and it
 * drags reported coverage down artificially. Coverage is the headline metric
 * reported to leadership, so this filter is directly load-bearing on the number
 * Reliance sees.
 *
 * Rejected values are recorded, never silently discarded (see
 * `fact_scan_rejected_daily`). If 8% of scans are junk, someone needs to know,
 * because that is an instrumentation bug in the app.
 */

const EAN_VALID = /^[0-9]{8,14}$/; // EAN-8, EAN-13, ITF-14, UPC-A

export type EanRejectReason =
  | 'url' // http, www, .com, .de, slashes — Ritu's case
  | 'empty'
  | 'too_short' // < 8 digits
  | 'too_long' // > 14 digits
  | 'non_numeric' // letters after stripping — usually a slug or SKU
  | 'placeholder'; // 0000000000000, 1111111111111, test strings

export type EanVerdict =
  | { ok: true; ean: string }
  | { ok: false; reason: EanRejectReason; raw: string };

export const EAN_REJECT_REASONS: EanRejectReason[] = [
  'url',
  'empty',
  'too_short',
  'too_long',
  'non_numeric',
  'placeholder',
];

export function normalizeEan(raw: unknown): EanVerdict {
  const s = String(raw ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '');
  if (!s) return { ok: false, reason: 'empty', raw: s };
  if (/^https?:\/\//i.test(s) || /(^www\.)|(\.(com|in|de|io|net|org)\b)|\//.test(s))
    return { ok: false, reason: 'url', raw: s };
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length === 0) return { ok: false, reason: 'non_numeric', raw: s };
  if (/^(0+|1+|9+)$/.test(digits)) return { ok: false, reason: 'placeholder', raw: s };
  if (digits.length < 8) return { ok: false, reason: 'too_short', raw: s };
  if (digits.length > 14) return { ok: false, reason: 'too_long', raw: s };
  if (!EAN_VALID.test(digits)) return { ok: false, reason: 'non_numeric', raw: s };
  return { ok: true, ean: digits };
}

/**
 * The SQL-side twin of `normalizeEan`, for the aggregation in §16.5 — applied
 * there so junk never reaches the mart in the first place.
 *
 * The two implementations must stay in sync. `tests/ean-parity.test.ts` runs a
 * fixture containing every reject reason through both and asserts identical
 * verdicts, so they cannot drift.
 */
// Companion sends the barcode as a numeric param (int_value) for real GS1 EANs
// and as a string only for internal ALU codes, so the value is read from either.
const EAN_VAL = `COALESCE(ps(event_params,'ean'), CAST(pi(event_params,'ean') AS STRING))`;
export const EAN_SQL_FILTER = `
  REGEXP_CONTAINS(REGEXP_REPLACE(TRIM(${EAN_VAL}), r'[^0-9]', ''), r'^[0-9]{8,14}$')
  AND NOT REGEXP_CONTAINS(LOWER(${EAN_VAL}), r'^https?://|www\\.|\\.(com|in|de|io|net|org)|/')
  AND NOT REGEXP_CONTAINS(REGEXP_REPLACE(TRIM(${EAN_VAL}), r'[^0-9]', ''), r'^(0+|1+|9+)$')
`.trim();

/**
 * A JS reimplementation of exactly what EAN_SQL_FILTER admits. Used only by the
 * parity test — production code calls `normalizeEan`.
 */
export function sqlFilterAdmits(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/[^0-9]/g, '');
  if (!/^[0-9]{8,14}$/.test(digits)) return false;
  if (/^https?:\/\/|www\.|\.(com|in|de|io|net|org)|\//.test(s.toLowerCase())) return false;
  if (/^(0+|1+|9+)$/.test(digits)) return false;
  return true;
}

/** Partition a batch of raw scan values, keeping rejects for the hygiene table. */
export function partitionEans(rawValues: unknown[]): {
  valid: string[];
  rejected: Map<EanRejectReason, string[]>;
  rejectionRate: number;
} {
  const valid: string[] = [];
  const rejected = new Map<EanRejectReason, string[]>();
  for (const raw of rawValues) {
    const v = normalizeEan(raw);
    if (v.ok) {
      valid.push(v.ean);
    } else {
      const bucket = rejected.get(v.reason) ?? [];
      bucket.push(v.raw);
      rejected.set(v.reason, bucket);
    }
  }
  const total = rawValues.length;
  const rejectedCount = total - valid.length;
  return { valid, rejected, rejectionRate: total === 0 ? 0 : rejectedCount / total };
}
