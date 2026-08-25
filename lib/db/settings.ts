/**
 * §12 — Seeded thresholds. These live in the database (`/settings`) so ops can
 * tune them without a deploy; this module holds the defaults and the typed
 * accessor.
 */

export interface Thresholds {
  coverage_target: number;
  crash_free_target: number;
  payment_success_target: number;
  api_error_ceiling: number;
  p0_ceiling: number;
  slo_p95_ms: Record<string, number>;
  /**
   * A10 — the latency SLOs above are placeholders. Real thresholds were never
   * established (§25). Alerting stays gated behind this per-endpoint flag until
   * the RPOS APIs doc and measured baselines confirm them; otherwise the
   * dashboard produces false breach alerts, or misses real ones.
   */
  slo_confirmed: Record<string, boolean>;
  /** §5.8 App Health Score weights. */
  health_weights: {
    crash_free: number;
    payment_success: number;
    api_error: number;
    latency: number;
    p0: number;
  };
  /** §28.4 anomaly thresholds. */
  anomaly_z_threshold: number;
  anomaly_wow_threshold: number;
  total_trends_stores: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  coverage_target: 0.97,
  crash_free_target: 0.995,
  payment_success_target: 0.97,
  api_error_ceiling: 0.05,
  p0_ceiling: 10,
  slo_p95_ms: {
    rpos_product_details: 800,
    apply_promotion: 1200,
    create_invoice: 1500,
    cart_update: 500,
    payment_initiate: 1000,
  },
  slo_confirmed: {
    rpos_product_details: false,
    apply_promotion: false,
    create_invoice: false,
    cart_update: false,
    payment_initiate: false,
  },
  health_weights: {
    crash_free: 30,
    payment_success: 20,
    api_error: 20,
    latency: 15,
    p0: 15,
  },
  anomaly_z_threshold: 2.5,
  anomaly_wow_threshold: 0.25,
  total_trends_stores: 1765,
};

/** Endpoint labels for `/app-health` — the five critical endpoints (§25). */
export const CRITICAL_ENDPOINTS = [
  { id: 'rpos_product_details', label: 'RPOS GET PRODUCT DETAILS', why: 'Catalogue fallback path' },
  { id: 'apply_promotion', label: 'Apply promotion / coupon', why: 'Known failure area, 5–10 item carts' },
  { id: 'create_invoice', label: 'createInvoice', why: 'Final journey step, RPOS dependency' },
  { id: 'cart_update', label: 'Cart add / update', why: 'Highest-frequency interaction' },
  { id: 'payment_initiate', label: 'Payment initiate', why: 'Revenue-critical' },
] as const;

let cached: Thresholds | null = null;

/**
 * Reads thresholds from `app_setting`, falling back to defaults. Cached per
 * process; `/settings` writes bust the cache.
 */
export async function getThresholds(): Promise<Thresholds> {
  if (cached) return cached;
  const { getDb } = await import('./client');
  const db = getDb();
  if (!db) {
    cached = DEFAULT_THRESHOLDS;
    return cached;
  }
  try {
    const { appSetting } = await import('./schema');
    const rows = await db.select().from(appSetting);
    const overrides = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cached = { ...DEFAULT_THRESHOLDS, ...overrides } as Thresholds;
  } catch {
    cached = DEFAULT_THRESHOLDS;
  }
  return cached;
}

export function invalidateThresholdCache(): void {
  cached = null;
}

/* ── §28 — AI guardrails ────────────────────────────────────────────────────
 *
 * Operator-editable house rules appended to every AI system prompt. They live in
 * `app_setting` (key `ai_guardrails`) so a PM can tune them from /settings without
 * a deploy. They ADD to the hard-coded safety rails (no PII, no fabricated
 * numbers, read-only SQL) — they can never switch those off.
 */
export const AI_GUARDRAILS_KEY = 'ai_guardrails';

/**
 * The starter guardrails. Deliberately conservative: the point is that the model
 * never confuses the reader or states anything that is not in the data.
 */
export const DEFAULT_AI_GUARDRAILS = `
# Companion dashboard — AI house rules

## Scope
- You speak only about the Companion "Scan & Go" app for Reliance Trends (open → scan → add to bag → pay → de-tag), production only.
- Do not comment on Kiosk, other Impetus products, or anything not present in the JSON context you were given.

## Truthfulness (most important)
- Use only numbers and facts that appear in the context. Never estimate, extrapolate, or invent a figure.
- If a value is marked stale, fixture, missing, or not_instrumented, say plainly that it is a data/instrumentation gap — never present it as a business result.
- If the context does not support an answer, say so and name the one thing a person should check. Do not guess a cause.
- Never state a cause as proven. Describe what the numbers are consistent with.

## Tone and format
- Neutral, factual, concise. No hype, no praise, no reassurance, no filler, no greeting, no sign-off, no emoji.
- Money in Indian numbering (lakh, crore) with the ₹ symbol. Percentages to one decimal.
- Refer to metrics by their id in square brackets, e.g. [orders], and always give the window.

## Safety
- Never output anything that looks like personal data (names, phone numbers, emails, customer ids).
- If asked to do something outside reporting on this dashboard, decline briefly and restate what you can help with.
`.trim();

let cachedGuardrails: string | null = null;

/** Reads the operator guardrails from `app_setting`, falling back to the default. */
export async function getAiGuardrails(): Promise<string> {
  if (cachedGuardrails != null) return cachedGuardrails;
  const { getDb } = await import('./client');
  const db = getDb();
  if (!db) {
    cachedGuardrails = DEFAULT_AI_GUARDRAILS;
    return cachedGuardrails;
  }
  try {
    const { appSetting } = await import('./schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(appSetting).where(eq(appSetting.key, AI_GUARDRAILS_KEY));
    const value = rows[0]?.value;
    cachedGuardrails = typeof value === 'string' && value.trim() ? value : DEFAULT_AI_GUARDRAILS;
  } catch {
    cachedGuardrails = DEFAULT_AI_GUARDRAILS;
  }
  return cachedGuardrails;
}

/** Upserts the guardrails and busts the cache. Returns false when no DB is present. */
export async function setAiGuardrails(text: string, updatedBy?: string): Promise<boolean> {
  const { getDb } = await import('./client');
  const db = getDb();
  if (!db) return false;
  const { appSetting } = await import('./schema');
  await db
    .insert(appSetting)
    .values({ key: AI_GUARDRAILS_KEY, value: text, description: 'AI Insights house guardrails (§28)', updatedBy })
    .onConflictDoUpdate({
      target: appSetting.key,
      set: { value: text, updatedBy, updatedAt: new Date() },
    });
  cachedGuardrails = text;
  return true;
}

export function invalidateGuardrailsCache(): void {
  cachedGuardrails = null;
}
