/**
 * The event dictionary and the instrumentation gap list.
 *
 * §13.10 — Prince Chaudhary asked for the registered Companion event list on
 * 6 Aug and it appears not to have been answered. This module is that answer,
 * and it is derived rather than hand-maintained: the expected taxonomy comes
 * from §5.2, the target taxonomy from the sibling Kiosk app (§5.9), and the
 * observed events from the GA4 export once `bq-ga4-events` is wired.
 *
 * Until then, `status: 'unverified'` is shown honestly. Nothing here claims an
 * event exists because a document said so.
 */
import { FUNNEL_STEPS } from '@/fixtures/business';

export type EventStatus =
  | 'confirmed' // seen in the GA4 export, or verified in production
  | 'expected' // in the funnel spec, not yet observed
  | 'unverified' // named in a doc, never checked against code or data
  | 'missing'; // in the target taxonomy, absent from Companion

export interface EventDef {
  name: string;
  /** The journey step it backs, if any. */
  step: string | null;
  params: string[];
  status: EventStatus;
  note?: string;
  /** Present in the Kiosk/Lyra container, which is the target taxonomy (§5.9). */
  inKioskTaxonomy: boolean;
}

/**
 * §16.2 — verified May 2026 on the scan event in *pre-production*. These are the
 * dimensions everything store-level depends on. A5/§13.11: each must be
 * confirmed present AND populated in the production export before the funnel or
 * coverage can be trusted — `store_id` above all, since everything store-level
 * collapses without it.
 */
export const SCAN_EVENT_PARAMS = [
  { param: 'ean', type: 'string', note: 'Barcode scanned' },
  { param: 'store_id', type: 'string', note: 'THE join key to dim_store' },
  { param: 'platform', type: 'string', note: 'Android / iOS' },
  { param: 'sales_channel', type: 'string', note: 'Tenant / channel discriminator' },
  { param: 'session_id', type: 'string', note: 'App-generated session' },
  { param: 'timestamp', type: 'string', note: 'ISO — prefer GA4 event_timestamp for ordering' },
  { param: 'result', type: 'string', note: 'found | not_found — THE catalogue coverage signal' },
] as const;

/**
 * §5.9 — the Kiosk / Lyra Self Checkout container has a fully documented 31-tag
 * GA4 setup. It is a different app and must not be queried, but it is the right
 * *target* taxonomy: where Companion lacks an equivalent, that is an
 * instrumentation ticket.
 */
export const KIOSK_TAXONOMY = [
  'session_start', 'session_end',
  'page_view_scan_items', 'page_view_cart', 'page_view_payment', 'page_view_home',
  'view_item', 'add_to_cart', 'view_cart', 'update_cart', 'remove_from_cart', 'clear_cart',
  'apply_coupon', 'remove_coupon',
  'begin_checkout', 'add_payment_info', 'purchase',
  'print_receipt', 'cancel_transaction', 'transaction_timed_out', 'order_failed',
  'api_error', 'payment_error',
  'start_clicked', 'mobile_login', 'sign_up', 'end_shopping_session',
  'use_my_own_bag', 'proceed_to_checkout', 'return_to_previous_screen',
] as const;

/** Events auto-injected on every Kiosk event — Companion should match. */
export const KIOSK_AUTO_PARAMS = ['session_id', 'timestamp', 'platform'] as const;

const KIOSK = new Set<string>(KIOSK_TAXONOMY);

/** The funnel events, with their §5.2 verification status. */
function funnelEvents(): EventDef[] {
  return FUNNEL_STEPS.filter((s) => !s.hidden).map((s) => {
    const status: EventStatus =
      s.confirmed === 'confirmed'
        ? 'confirmed'
        : s.confirmed === 'ga4_standard'
          ? 'expected'
          : !s.instrumented
            ? 'missing'
            : 'unverified';
    return {
      name: s.step,
      step: s.step,
      params:
        s.confirmed === 'confirmed'
          ? SCAN_EVENT_PARAMS.map((p) => p.param)
          : [...KIOSK_AUTO_PARAMS],
      status,
      note:
        s.step === 'invoice_detag'
          ? 'A6 — never confirmed, and likely not instrumented. The final step of the core journey is invisible today.'
          : s.confirmed === 'verify'
            ? 'Event name expected from the Kiosk schema — verify against hashira-theme GTM constants (Phase 1).'
            : undefined,
      inKioskTaxonomy: KIOSK.has(s.step),
    };
  });
}

/**
 * Events Companion is missing relative to the target taxonomy. Each row is an
 * instrumentation ticket waiting to be written, and several are already known
 * sprint items (failed-scan events, apply-promotion failure events).
 */
export function instrumentationGaps(): Array<{ event: string; why: string; priority: 'P0' | 'P1' | 'P2' }> {
  const have = new Set(FUNNEL_STEPS.map((s) => s.step));
  const HIGH_VALUE: Record<string, { why: string; priority: 'P0' | 'P1' | 'P2' }> = {
    payment_error: {
      why: 'Payment failure reasons cannot be ranked without it — /app-health currently infers failure from purchase÷add_payment_info.',
      priority: 'P0',
    },
    api_error: {
      why: 'API error rate falls back to a Sentry proxy. The client-side view of which screen failed is missing.',
      priority: 'P0',
    },
    order_failed: {
      why: 'Failed orders are invisible; only successful purchases are counted.',
      priority: 'P0',
    },
    apply_coupon: {
      why: 'Coupon attach rate is derived from order rows rather than observed behaviour. Apply-promotion FAILURE events were an open sprint item.',
      priority: 'P1',
    },
    remove_coupon: { why: 'Coupon abandonment is unobservable.', priority: 'P2' },
    remove_from_cart: { why: 'Cart abandonment within the bag is unobservable.', priority: 'P1' },
    update_cart: { why: 'Quantity changes are unobservable.', priority: 'P2' },
    cancel_transaction: {
      why: 'Explicit cancellation cannot be separated from a silent drop-off.',
      priority: 'P1',
    },
    transaction_timed_out: {
      why: 'Timeouts cannot be separated from cancellations — both are needed for payment_failure_rate (§5.6).',
      priority: 'P1',
    },
    session_end: { why: 'Session duration and end reason are unavailable.', priority: 'P2' },
    print_receipt: { why: 'Kiosk-only equivalent of the de-tag/invoice step.', priority: 'P2' },
  };

  return KIOSK_TAXONOMY.filter((e) => !have.has(e))
    .map((event) => ({
      event,
      why: HIGH_VALUE[event]?.why ?? 'Present in the Kiosk taxonomy, absent from Companion.',
      priority: HIGH_VALUE[event]?.priority ?? 'P2',
    }))
    .sort((a, b) => a.priority.localeCompare(b.priority));
}

export function eventDictionary(): EventDef[] {
  return funnelEvents();
}

/** What each gap costs the dashboard — used to prioritise the tickets. */
export function gapImpact(): Array<{ metric: string; blockedBy: string[] }> {
  return [
    { metric: 'payment_failure_rate', blockedBy: ['payment_error', 'transaction_timed_out'] },
    { metric: 'api_error_rate (client-side)', blockedBy: ['api_error'] },
    { metric: 'coupon_attach_rate (observed)', blockedBy: ['apply_coupon'] },
    { metric: 'cart abandonment', blockedBy: ['remove_from_cart', 'update_cart'] },
    { metric: 'invoice / de-tag completion', blockedBy: ['invoice_detag'] },
    { metric: 'time_to_order_p50', blockedBy: ['session-level event sequencing'] },
  ];
}
