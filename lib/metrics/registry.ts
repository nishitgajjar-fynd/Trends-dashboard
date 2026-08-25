/**
 * §5 — The metric dictionary. THIS SECTION IS THE CONTRACT.
 *
 * Every metric is defined here once, with a formula, a source, and a grain.
 * The API and the UI import from here. No metric arithmetic in components — if a
 * component computes a percentage, that is a bug (§9.2).
 *
 * If a metric isn't here, add it here first, then implement.
 */

export type MetricUnit = 'count' | 'inr' | 'ratio' | 'ms' | 'score' | 'days';
export type MetricDomain =
  | 'loyalty'
  | 'business'
  | 'journey'
  | 'stores'
  | 'catalogue'
  | 'app_health'
  | 'issues';
export type Grain =
  | 'day'
  | 'day × store'
  | 'day × store × state'
  | 'week'
  | 'month'
  | 'window'
  | 'day × endpoint';

/** Higher is better, lower is better, or neither. Drives delta colouring. */
export type Direction = 'up_good' | 'down_good' | 'neutral';

export interface MetricDef {
  id: string;
  label: string;
  domain: MetricDomain;
  unit: MetricUnit;
  direction: Direction;
  /** The formula, verbatim from §5 — rendered in the UI tooltip and lineage view. */
  formula: string;
  /** Which connector / table it comes from. Shown on every card (§9.2). */
  source: string;
  grain: Grain;
  /** Plain-language description for the owner-facing tooltip. */
  description: string;
  /** Refresh cadence from §6.4. */
  cadence: string;
  /** A §13 blocker or an open-assumption caveat to surface with the number. */
  caveat?: string;
  /** Ambiguity the UI must label rather than resolve silently. */
  ambiguous?: boolean;
}

export const METRICS = {
  /* ── §5.1 Business ─────────────────────────────────────────────────── */
  orders: {
    id: 'orders',
    label: 'Orders',
    domain: 'business',
    unit: 'count',
    direction: 'up_good',
    formula: 'count of distinct order id where status is a confirmed/completed state',
    source: 'avis_base_view (bq-orders), filtered to affiliate_id = COMPANION_PROD_AFFILIATE_ID',
    grain: 'day × store',
    description: 'Completed Companion orders. Cancellations excluded.',
    cadence: '60 min, plus 02:00 IST full-day rebuild',
  },
  orders_confirmed: {
    id: 'orders_confirmed',
    label: 'Orders (confirmed only)',
    domain: 'business',
    unit: 'count',
    direction: 'up_good',
    formula: 'count of distinct order id where status IN confirmed_statuses',
    source: 'avis_base_view (bq-orders)',
    grain: 'day × store',
    description:
      'The stricter variant, computed alongside `orders` while the status enum is unconfirmed. Better a labelled approximation than a confident wrong number.',
    cadence: '60 min',
    caveat:
      'Same as Orders right now — we only load completed orders, so there is nothing extra to exclude yet.',
    ambiguous: true,
  },
  egmv: {
    id: 'egmv',
    label: 'e-GMV',
    domain: 'business',
    unit: 'inr',
    direction: 'up_good',
    formula: 'sum of gross order value before discounts, cancellations excluded',
    source: 'avis_base_view (bq-orders)',
    grain: 'day × store',
    description: 'Gross merchandise value transacted through Companion.',
    cadence: '60 min',
  },
  net_revenue: {
    id: 'net_revenue',
    label: 'Net revenue',
    domain: 'business',
    unit: 'inr',
    direction: 'up_good',
    formula: 'egmv − discount_amount − coupon_amount − returns',
    source: 'avis_base_view (bq-orders)',
    grain: 'day × store',
    description: 'Revenue after discounts, coupons and returns.',
    cadence: '60 min',
    caveat:
      'Same as e-GMV for now — discounts and coupons are not tracked yet, so nothing is subtracted.',
  },
  aov: {
    id: 'aov',
    label: 'Average order value',
    domain: 'business',
    unit: 'inr',
    direction: 'up_good',
    formula: 'net_revenue / orders',
    source: 'derived',
    grain: 'day × store',
    description: 'What an average Companion basket is worth after discounting.',
    cadence: '60 min',
  },
  units_per_order: {
    id: 'units_per_order',
    label: 'Units per order',
    domain: 'business',
    unit: 'count',
    direction: 'up_good',
    formula: 'total_units / orders',
    source: 'avis_base_view (bq-orders)',
    grain: 'day',
    description: 'Basket size in items.',
    cadence: '60 min',
  },
  discount_rate: {
    id: 'discount_rate',
    label: 'Discount rate',
    domain: 'business',
    unit: 'ratio',
    direction: 'down_good',
    formula: '(discount + coupon) / egmv',
    source: 'derived',
    grain: 'day',
    description: 'Share of gross value given away in discounts and coupons.',
    cadence: '60 min',
  },
  coupon_attach_rate: {
    id: 'coupon_attach_rate',
    label: 'Coupon attach rate',
    domain: 'business',
    unit: 'ratio',
    direction: 'neutral',
    formula: 'orders with a coupon / orders',
    source: 'avis_base_view, or GA4 apply_coupon',
    grain: 'day',
    description: 'How often a coupon is used.',
    cadence: '60 min',
  },
  new_customers: {
    id: 'new_customers',
    label: 'New customers',
    domain: 'business',
    unit: 'count',
    direction: 'up_good',
    formula: 'distinct customers with first Companion order in window',
    source: 'avis_base_view (bq-orders)',
    grain: 'day',
    description: 'First-time Companion buyers. Computed on hashed customer ids (§27.4).',
    cadence: '60 min',
  },
  repeat_rate: {
    id: 'repeat_rate',
    label: 'Repeat rate',
    domain: 'business',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'repeat customers / total ordering customers',
    source: 'derived',
    grain: 'week',
    description: 'Does Companion bring people back.',
    cadence: '60 min',
  },
  revenue_mom: {
    id: 'revenue_mom',
    label: 'Revenue MoM',
    domain: 'business',
    unit: 'ratio',
    direction: 'up_good',
    formula: '(rev_this_month_to_date / rev_same_period_last_month) − 1',
    source: 'derived',
    grain: 'month',
    description: 'Month-on-month revenue growth, like-for-like on days elapsed.',
    cadence: '60 min',
  },

  /* ── §5.2 Journey / funnel ─────────────────────────────────────────── */
  scan_success_rate: {
    id: 'scan_success_rate',
    label: 'Scan success rate',
    domain: 'journey',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'scan_result_found / scan_attempts',
    source: 'GA4 export (bq-ga4-events), scan event `result` param',
    grain: 'day × store',
    description: 'Of every scan attempted, how many resolved to a product.',
    cadence: '60 min',
    caveat: 'A5 — scan-event params confirmed in pre-production only. Re-verify in production (§13.11).',
  },
  atc_rate: {
    id: 'atc_rate',
    label: 'Add-to-bag rate',
    domain: 'journey',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'add_to_cart / scan_success',
    source: 'GA4 export (bq-ga4-events)',
    grain: 'day',
    description: 'Of successful scans, how many become a bag item.',
    cadence: '60 min',
  },
  checkout_rate: {
    id: 'checkout_rate',
    label: 'Checkout initiation rate',
    domain: 'journey',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'begin_checkout / view_cart',
    source: 'GA4 export (bq-ga4-events)',
    grain: 'day',
    description: 'Of carts viewed, how many start checkout.',
    cadence: '60 min',
  },
  payment_success_rate: {
    id: 'payment_success_rate',
    label: 'Payment success rate',
    domain: 'journey',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'purchase / add_payment_info',
    source: 'GA4 export (bq-ga4-events)',
    grain: 'day',
    description:
      "The app's view of payment success. Gateway-side data is not available in v1, so this measures what the app observed (§26).",
    cadence: '60 min',
  },
  session_conversion: {
    id: 'session_conversion',
    label: 'Session→purchase conversion',
    domain: 'journey',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'sessions_with_purchase / sessions',
    source: 'GA4 export (bq-ga4-events)',
    grain: 'day',
    description: 'End-to-end conversion of an app session into an order.',
    cadence: '60 min',
  },
  /* §16.4 — discovered journeys. These describe paths nobody declared, so their
     formulas are stated over `fact_journey_path` rather than over FUNNEL_STEPS. */
  journeys_discovered: {
    id: 'journeys_discovered',
    label: 'Journeys discovered',
    domain: 'journey',
    unit: 'count',
    direction: 'neutral',
    formula: 'distinct branches found in the session-path prefix tree above the branch threshold',
    source: 'GA4 export (bq-ga4-journeys), fact_journey_path',
    grain: 'window',
    description:
      'How many distinct routes through the app people actually took. Not a target — a count of shapes found.',
    cadence: 'daily',
    caveat:
      'Sensitive to the branch threshold (20% of parent). A lower threshold finds more journeys, not more truth.',
  },
  journey_worst_exit_rate: {
    id: 'journey_worst_exit_rate',
    label: 'Worst single exit rate',
    domain: 'journey',
    unit: 'ratio',
    direction: 'down_good',
    formula: 'sessions that ended at the worst step / sessions that reached the step before it',
    source: 'GA4 export (bq-ga4-journeys), fact_journey_path',
    grain: 'window',
    description:
      'The largest share of sessions to leave the app outright at one step of the highest-impact discovered journey.',
    cadence: 'daily',
    caveat:
      'Exits only. `1 − retention` would be larger and would count sessions that forked to another route as losses, which they are not — the finding on the page uses this same basis so the two cannot disagree.',
  },
  journey_sessions_at_risk: {
    id: 'journey_sessions_at_risk',
    label: 'Sessions lost at worst steps',
    domain: 'journey',
    unit: 'count',
    direction: 'down_good',
    formula: 'Σ over discovered journeys of sessions lost at that journey’s worst step',
    source: 'GA4 export (bq-ga4-journeys), fact_journey_path',
    grain: 'window',
    description: 'The size of the problem, added up across every journey found.',
    cadence: 'daily',
    caveat:
      'Journeys can share a prefix, so a session lost early may be counted on two journeys. This is an upper bound, not a sum of distinct sessions.',
  },
  journey_path_coverage: {
    id: 'journey_path_coverage',
    label: 'Path coverage',
    domain: 'journey',
    unit: 'ratio',
    direction: 'up_good',
    formula: '(sessions on stored paths) / (all sessions, including the (other) bucket)',
    source: 'GA4 export (bq-ga4-journeys), fact_journey_path',
    grain: 'window',
    description:
      'What share of sessions took a path common enough to be stored individually. The remainder is real traffic on rare paths, not missing data.',
    cadence: 'daily',
  },
  time_to_order_p50: {
    id: 'time_to_order_p50',
    label: 'Median scan→purchase time',
    domain: 'journey',
    unit: 'ms',
    direction: 'down_good',
    formula: 'weighted median of per-path elapsed time, over paths ending in a revenue event',
    source: 'GA4 export (bq-ga4-journeys), fact_journey_path',
    grain: 'window',
    description: 'How long buying actually takes. Slow steps are as much a problem as failed ones.',
    cadence: 'daily',
    caveat:
      'Median of per-path medians, weighted by sessions — an approximation. The true pooled median needs per-session durations, which fact_journey_path deliberately does not store. Measured only over paths ending in a revenue event: including abandoned sessions would mostly measure browsing.',
  },

  /* ── §5.3 Store adoption ───────────────────────────────────────────── */
  stores_live: {
    id: 'stores_live',
    label: 'Stores live',
    domain: 'stores',
    unit: 'count',
    direction: 'up_good',
    formula: 'distinct stores with Companion enabled (from store master)',
    source: 'bq-store-master → dim_store',
    grain: 'day × store × state',
    description: 'Stores where Companion is switched on.',
    cadence: 'Daily 06:00 IST',
  },
  stores_active: {
    id: 'stores_active',
    label: 'Active stores',
    domain: 'stores',
    unit: 'count',
    direction: 'up_good',
    formula: 'distinct stores with ≥1 order in the selected window',
    source: 'fact_orders × dim_store',
    grain: 'day × store × state',
    description: 'Stores that transacted in the selected period.',
    cadence: '60 min',
  },
  store_activation_pct: {
    id: 'store_activation_pct',
    label: 'Activation %',
    domain: 'stores',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'stores_live / total_trends_stores',
    source: 'derived (denominator 1,765, configurable)',
    grain: 'day × store × state',
    description: 'Rollout progress across the Trends estate.',
    cadence: 'Daily 06:00 IST',
  },
  daily_order_compliance: {
    id: 'daily_order_compliance',
    label: 'Daily-order compliance',
    domain: 'stores',
    unit: 'ratio',
    direction: 'up_good',
    formula: "stores with ≥1 order on the window's last day / active stores",
    source: 'fact_store_adoption_daily',
    grain: 'day × store × state',
    description:
      'The NOC daily rhythm metric: did every active store transact on the most recent day in view.',
    cadence: '60 min',
    caveat:
      "Anchored to the window's last day, not the wall clock. Trailing windows end yesterday because today is partial, so measuring against the wall clock made every store read zero and compliance read 0.0% — a business collapse that was really a date-range artefact.",
  },
  stores_dark: {
    id: 'stores_dark',
    label: 'Dark stores',
    domain: 'stores',
    unit: 'count',
    direction: 'down_good',
    formula: 'live stores with 0 orders in the selected window',
    source: 'fact_orders × dim_store',
    grain: 'day × store × state',
    description: 'Live stores that did not transact in the selected period — the NOC call list.',
    cadence: '60 min',
  },
  orders_per_active_store: {
    id: 'orders_per_active_store',
    label: 'Orders per active store / day',
    domain: 'stores',
    unit: 'count',
    direction: 'up_good',
    formula: 'orders / stores_active',
    source: 'derived',
    grain: 'day × store × state',
    description: 'Depth of adoption where Companion is being used.',
    cadence: '60 min',
  },
  days_since_last_order: {
    id: 'days_since_last_order',
    label: 'Days dark',
    domain: 'stores',
    unit: 'days',
    direction: 'down_good',
    formula: 'per store, days since last order',
    source: 'fact_store_adoption_daily',
    grain: 'day × store',
    description: 'How long a store has been silent.',
    cadence: '60 min',
  },

  /* ── §5.4 Catalogue health ─────────────────────────────────────────── */
  unique_coverage: {
    id: 'unique_coverage',
    label: 'Unique catalogue coverage',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'up_good',
    formula: '(unique_scans − unique_failed) / unique_scans',
    source: 'slack-catalogue-report (Tatsu daily), moving to bq-ga4-events',
    grain: 'window',
    description:
      'Scan-observed coverage: of the distinct products customers tried to scan, how many resolved. This is the headline reported to leadership — the name and formula are kept identical to existing reporting so numbers never diverge.',
    cadence: 'On bot post, poll every 30 min',
  },
  total_coverage: {
    id: 'total_coverage',
    label: 'Total scan coverage',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'up_good',
    formula: '(total_scans − total_failed) / total_scans',
    source: 'slack-catalogue-report',
    grain: 'window',
    description: 'Coverage weighted by scan volume rather than distinct products.',
    cadence: 'On bot post',
  },
  audited_coverage: {
    id: 'audited_coverage',
    label: 'Store-visit audited coverage',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'up_good',
    formula: '(items_scanned − items_failed) / items_scanned, over auditor shelf samples',
    source: 'fact_store_visit_audit',
    grain: 'window',
    description:
      'Of what is physically on the shelf, how much is scannable. Runs far below scan-observed coverage because customers mostly scan things that work while an auditor scans at random. Never blend the two (§16.5.2).',
    cadence: 'Per store visit',
  },
  true_coverage: {
    id: 'true_coverage',
    label: 'True coverage',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'companion_sku_count / sap_sku_count',
    source: 'fact_catalogue_truth_daily (SAP master + RRA inventory)',
    grain: 'day × store',
    description:
      'Of what should exist on the floor, how much is scannable. Not wired in v1 — the feeds are deferred (§13.9).',
    cadence: 'Deferred',
    caveat: 'MODULE_TRUE_COVERAGE is off. The schema exists; the feed does not.',
  },
  missing_distinct: {
    id: 'missing_distinct',
    label: 'Distinct missing products',
    domain: 'catalogue',
    unit: 'count',
    direction: 'down_good',
    formula: "count distinct EAN with result = 'not_found' in window",
    source: 'fact_scan_daily / slack-catalogue-report',
    grain: 'window',
    description: 'How many distinct products failed to scan.',
    cadence: 'Daily',
  },
  missing_new: {
    id: 'missing_new',
    label: 'New missing EANs',
    domain: 'catalogue',
    unit: 'count',
    direction: 'down_good',
    formula: 'EANs first appearing as not_found today',
    source: 'fact_catalogue_gap',
    grain: 'day',
    description: 'Newly broken products — a spike points upstream.',
    cadence: 'Daily',
  },
  missing_resolved: {
    id: 'missing_resolved',
    label: 'Resolved (7d)',
    domain: 'catalogue',
    unit: 'count',
    direction: 'up_good',
    formula: 'EANs previously missing, now scanning as found',
    source: 'fact_catalogue_gap',
    grain: 'window',
    description: 'Gaps actually closed this week.',
    cadence: 'Daily',
  },
  missing_age_p50: {
    id: 'missing_age_p50',
    label: 'Median gap age',
    domain: 'catalogue',
    unit: 'days',
    direction: 'down_good',
    formula: 'median days from first-seen to now for unresolved EANs',
    source: 'fact_catalogue_gap',
    grain: 'window',
    description: 'A miss that is 30 days old is an ownership failure, not a data issue.',
    cadence: 'Daily',
  },
  store_coverage: {
    id: 'store_coverage',
    label: 'Coverage by store',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'unique_coverage grouped by store_id',
    source: 'fact_scan_daily',
    grain: 'day × store × state',
    description: 'Is the gap systemic or store-specific.',
    cadence: 'Daily',
  },
  scan_rejection_rate: {
    id: 'scan_rejection_rate',
    label: 'Scan EAN rejection rate',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'down_good',
    formula: 'rejected_scans / total_scans',
    source: 'fact_scan_rejected_daily',
    grain: 'day',
    description:
      'Share of scan events whose `ean` param was junk (URLs, placeholders, slugs). A high rate is an app instrumentation bug, and it distorts coverage in both directions (§16.5.1).',
    cadence: '60 min',
  },
  report_generated: {
    id: 'report_generated',
    label: 'Daily report health',
    domain: 'catalogue',
    unit: 'count',
    direction: 'up_good',
    formula: 'did the bot post today’s report — boolean',
    source: 'slack-catalogue-report',
    grain: 'day',
    description:
      'The Tatsu report has silently stopped generating before (flagged 11 Aug). This makes the second time impossible.',
    cadence: 'Poll every 30 min',
  },

  /* §5.4b — catalogue *completeness* (from sng-prod.catalogue_health). A
     different question from scan coverage: not "did a scan resolve" but "is the
     product record complete — attributes filled, image present, on platform". */
  catalogue_completion: {
    id: 'catalogue_completion',
    label: 'Catalogue completeness',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'complete_catalog / total_catalog',
    source: 'catalogue_health.geckoboard_summary_v2 (bq-catalogue-health)',
    grain: 'window',
    description:
      'Share of catalogue records that are complete — every key attribute and a primary image present. Distinct from scan-observed coverage; this is about the record, not the scan.',
    cadence: 'Daily snapshot',
  },
  catalogue_fill_rate: {
    id: 'catalogue_fill_rate',
    label: 'Attribute fill rate',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'mean attribute fill rate across the catalogue',
    source: 'catalogue_health.geckoboard_summary_v2 (bq-catalogue-health)',
    grain: 'window',
    description: 'On average, how much of each product record is filled in.',
    cadence: 'Daily snapshot',
  },
  catalogue_media_coverage: {
    id: 'catalogue_media_coverage',
    label: 'Media coverage',
    domain: 'catalogue',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'products_with_images / total_catalog',
    source: 'catalogue_health.media_health_v2 (bq-catalogue-health)',
    grain: 'window',
    description: 'Share of products that carry at least one image.',
    cadence: 'Daily snapshot',
  },
  catalogue_missing_records: {
    id: 'catalogue_missing_records',
    label: 'Incomplete records',
    domain: 'catalogue',
    unit: 'count',
    direction: 'down_good',
    formula: 'total_catalog − complete_catalog',
    source: 'catalogue_health.geckoboard_summary_v2 (bq-catalogue-health)',
    grain: 'window',
    description: 'How many catalogue records are still missing required attributes or media.',
    cadence: 'Daily snapshot',
  },
  catalogue_complete_records: {
    id: 'catalogue_complete_records',
    label: 'Completed products',
    domain: 'catalogue',
    unit: 'count',
    direction: 'up_good',
    formula: 'complete_catalog',
    source: 'catalogue_health.geckoboard_summary_v2 (bq-catalogue-health)',
    grain: 'window',
    description: 'How many catalogue records are complete — all required attributes and media present, on platform.',
    cadence: 'Daily snapshot',
  },

  /* ── §5.6 App / tech health ────────────────────────────────────────── */
  crash_free_rate: {
    id: 'crash_free_rate',
    label: 'Crash-free session rate',
    domain: 'app_health',
    unit: 'ratio',
    direction: 'up_good',
    formula: '1 − (crashed_sessions / sessions)',
    source: 'sentry (org fynd-f7), sessions endpoint',
    grain: 'day',
    description:
      'Session rate, not user rate — the figure leadership understands. User rate is in the drilldown.',
    cadence: '15 min',
  },
  api_error_rate: {
    id: 'api_error_rate',
    label: 'API error rate',
    domain: 'app_health',
    unit: 'ratio',
    direction: 'down_good',
    formula: 'api_errors / api_calls (or GA4 api_error / sessions as proxy)',
    source: 'sentry / GA4',
    grain: 'day',
    description: 'Share of API calls failing.',
    cadence: '15 min',
  },
  p95_latency: {
    id: 'p95_latency',
    label: 'p95 latency',
    domain: 'app_health',
    unit: 'ms',
    direction: 'down_good',
    formula: '95th percentile response time per endpoint',
    source: 'api-latency (APM / backend logs / synthetic)',
    grain: 'day × endpoint',
    description: 'Tail latency on the five critical endpoints.',
    cadence: '60 min',
    caveat:
      'A10 — the SLOs are placeholders (§25). Alerting stays gated behind slo_confirmed per endpoint until real thresholds are established.',
  },
  error_log_volume: {
    id: 'error_log_volume',
    label: 'Backend error log volume',
    domain: 'app_health',
    unit: 'count',
    direction: 'down_good',
    formula: 'count of severity=ERROR for scne-hashira-main-srvr',
    source: 'gcp-logging (project sng-prod)',
    grain: 'day',
    description: 'Backend error volume, with deploy markers overlaid.',
    cadence: '15 min',
  },
  payment_failure_rate: {
    id: 'payment_failure_rate',
    label: 'Payment failure rate',
    domain: 'app_health',
    unit: 'ratio',
    direction: 'down_good',
    formula: '(payment_error + transaction_timed_out) / payment_attempts',
    source: 'GA4 / backend',
    grain: 'day',
    description: "The app's view of payment failure (§26).",
    cadence: '60 min',
  },
  release_adoption: {
    id: 'release_adoption',
    label: 'Release adoption',
    domain: 'app_health',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'sessions by SDK/host version, as share',
    source: 'GA4 app_version, cross-checked against Sentry releases',
    grain: 'day',
    description: 'Version fragmentation is a real support cost.',
    cadence: '60 min',
  },
  geofence_delivery_rate: {
    id: 'geofence_delivery_rate',
    label: 'Geofence notification delivery',
    domain: 'app_health',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'delivered / triggered, split by platform',
    source: 'backend',
    grain: 'day',
    description: 'Known platform-specific issue — Android and iOS behave differently.',
    cadence: '60 min',
  },
  app_health_score: {
    id: 'app_health_score',
    label: 'App Health Score',
    domain: 'app_health',
    unit: 'score',
    direction: 'up_good',
    formula:
      '30×crash_free + 20×payment_success + 20×(1−clamp(api_error/ceiling)) + 15×latency_score + 15×(1−clamp(p0_open/ceiling))',
    source: 'derived (§5.8)',
    grain: 'day',
    description:
      'A single 0–100 number for the hub light, always decomposable. Components with no data are excluded and the weights renormalised — never substitute zero for missing.',
    cadence: '15 min',
  },

  /* ── §5.7 Issues ───────────────────────────────────────────────────── */
  p0_open: {
    id: 'p0_open',
    label: 'Open P0',
    domain: 'issues',
    unit: 'count',
    direction: 'down_good',
    formula: 'count of Jira NI issues, priority Highest/P0, status not Done',
    source: 'jira (project NI, board 11030)',
    grain: 'day',
    description: 'Live P0 count.',
    cadence: '30 min',
    caveat:
      'A11 — the NI board is shared across Companion, Scan & Go, Kiosk and the Catalogue pipeline. Without a component/label filter this count inherits other products’ bugs (§22.1).',
    ambiguous: true,
  },
  p0_age_p50: {
    id: 'p0_age_p50',
    label: 'Median P0 age',
    domain: 'issues',
    unit: 'days',
    direction: 'down_good',
    formula: 'median days open',
    source: 'jira',
    grain: 'day',
    description: 'How long P0s are surviving.',
    cadence: '30 min',
  },
  issues_unowned: {
    id: 'issues_unowned',
    label: 'Unowned issues',
    domain: 'issues',
    unit: 'count',
    direction: 'down_good',
    formula: 'open issues with no assignee',
    source: 'jira',
    grain: 'day',
    description: 'Work nobody has picked up.',
    cadence: '30 min',
  },
  open_close_ratio: {
    id: 'open_close_ratio',
    label: 'Opened per closed (7d)',
    domain: 'issues',
    /**
     * A quotient of two counts, not a proportion.
     *
     * It was declared `ratio`, and `ratio` in this registry means 0–1 and is
     * rendered as a percentage — so 1.5 opened for every 1 closed printed as
     * "150%", which reads as a share of something and is not one. Nobody closes
     * 150% of their issues. `score` renders it as `1.5`, which is what the
     * number is, and the description says which side of 1 is bad.
     *
     * Caught by the reconciliation suite's "every rate is inside 0–1" check —
     * the point of that check is that a unit is a claim about the number.
     */
    unit: 'score',
    direction: 'down_good',
    formula: 'issues opened / issues closed in the trailing 7 days',
    source: 'jira',
    grain: 'week',
    description:
      'Above 1 means the backlog is growing: more issues arrived than were closed. Below 1 means it is shrinking.',
    cadence: '30 min',
  },

  /* ── Loyalty (ADR-001 — a deliberate departure from §0) ─────────────── */
  //
  // Every metric here is marked ambiguous on purpose. The spec records the
  // Loyalty property id and nothing about its events, so the taxonomy behind
  // these is a proposal until the §16.1 inventory query settles it. They are
  // rendered with that caveat visible rather than as established fact, and
  // they are deliberately kept out of the App Health Score, the hub health
  // lights, and the AI brief's Companion context.
  loyalty_members_active: {
    id: 'loyalty_members_active',
    label: 'Active loyalty members',
    domain: 'loyalty',
    unit: 'count',
    direction: 'up_good',
    formula: 'distinct users with any Reliance One event in window',
    source: 'bq-loyalty — GA4 export in fynd-jio-impetus-prod',
    grain: 'day',
    description: 'Loyalty-side activity. A loyalty member is not the same population as a Companion user.',
    cadence: 'Daily',
    caveat: 'ADR-001 — the Loyalty event taxonomy is unverified; this is a proposal, not a settled figure.',
    ambiguous: true,
  },
  loyalty_enrolments: {
    id: 'loyalty_enrolments',
    label: 'New enrolments',
    domain: 'loyalty',
    unit: 'count',
    direction: 'up_good',
    formula: 'count of enrolment events in window',
    source: 'bq-loyalty',
    grain: 'day',
    description: 'New Reliance One 2.0 sign-ups.',
    cadence: 'Daily',
    caveat: 'ADR-001 — event name unconfirmed.',
    ambiguous: true,
  },
  loyalty_links: {
    id: 'loyalty_links',
    label: 'Accounts linked',
    domain: 'loyalty',
    unit: 'count',
    direction: 'up_good',
    formula: 'count of account-link events in window',
    source: 'bq-loyalty',
    grain: 'day',
    description: 'Existing accounts linked to the app.',
    cadence: 'Daily',
    caveat: 'ADR-001 — event name unconfirmed.',
    ambiguous: true,
  },
  loyalty_points_earned: {
    id: 'loyalty_points_earned',
    label: 'Points earned',
    domain: 'loyalty',
    unit: 'count',
    direction: 'up_good',
    formula: 'sum of the points param on earn events',
    source: 'bq-loyalty',
    grain: 'day',
    description: 'Points issued to members.',
    cadence: 'Daily',
    caveat: 'ADR-001 — the `points` parameter is assumed, not verified.',
    ambiguous: true,
  },
  loyalty_points_redeemed: {
    id: 'loyalty_points_redeemed',
    label: 'Points redeemed',
    domain: 'loyalty',
    unit: 'count',
    direction: 'up_good',
    formula: 'sum of the points param on redeem events',
    source: 'bq-loyalty',
    grain: 'day',
    description: 'Points spent by members.',
    cadence: 'Daily',
    caveat: 'ADR-001 — the `points` parameter is assumed, not verified.',
    ambiguous: true,
  },
  loyalty_redemption_rate: {
    id: 'loyalty_redemption_rate',
    label: 'Redemption rate',
    domain: 'loyalty',
    unit: 'ratio',
    direction: 'up_good',
    formula: 'loyalty_points_redeemed / loyalty_points_earned',
    source: 'derived',
    grain: 'day',
    description: 'What share of issued points members actually spend. Low redemption is a liability building up.',
    cadence: 'Daily',
    caveat: 'ADR-001 — derived from two unverified inputs.',
    ambiguous: true,
  },
} as const satisfies Record<string, MetricDef>;

export type MetricId = keyof typeof METRICS;

export function getMetric(id: string): MetricDef | undefined {
  return (METRICS as Record<string, MetricDef>)[id];
}

export function metricsForDomain(domain: MetricDomain): MetricDef[] {
  return Object.values(METRICS as Record<string, MetricDef>).filter((m) => m.domain === domain);
}

export const ALL_METRIC_IDS = Object.keys(METRICS) as MetricId[];
