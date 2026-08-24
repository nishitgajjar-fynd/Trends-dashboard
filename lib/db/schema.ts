/**
 * §7 — Warehouse schemas. Postgres DDL for the serving marts.
 *
 * Everything grain-explicit and tenant-aware: `tenant` is a first-class
 * dimension everywhere so adding Yousta/Azorte is a config change, not a
 * migration (§0).
 *
 * BigQuery is the system of record; Postgres is the serving layer (§6.1).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/* ── §7.1 Dimensions ─────────────────────────────────────────────────────── */

export const dimStore = pgTable('dim_store', {
  storeKey: serial('store_key').primaryKey(),
  storeId: text('store_id').notNull().unique(), // platform store id
  storeCode: text('store_code'), // retail store code (from sheet)
  storeName: text('store_name'),
  city: text('city'),
  state: text('state'),
  region: text('region'),
  tenant: text('tenant').notNull().default('trends'),
  companionLive: boolean('companion_live').notNull().default(false),
  activatedOn: date('activated_on'),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lon: numeric('lon', { precision: 9, scale: 6 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dimProduct = pgTable(
  'dim_product',
  {
    productKey: serial('product_key').primaryKey(),
    itemCode: text('item_code'),
    ean: text('ean'),
    name: text('name'),
    brand: text('brand'),
    category: text('category'),
    categoryMapped: boolean('category_mapped'),
    mrp: numeric('mrp', { precision: 12, scale: 2 }),
    isActive: boolean('is_active'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('dim_product_ean_item_code_key').on(t.ean, t.itemCode), index('dim_product_ean_idx').on(t.ean)],
);

export const dimDate = pgTable('dim_date', {
  dateKey: date('date_key').primaryKey(),
  isoWeek: integer('iso_week'),
  month: integer('month'),
  quarter: integer('quarter'),
  year: integer('year'),
  isWeekend: boolean('is_weekend'),
  /** Independence Day Sale, EOSS etc. Sale flags matter for comparability (§28.2). */
  isSalePeriod: boolean('is_sale_period'),
  saleName: text('sale_name'),
});

/* ── §7.2 Orders ─────────────────────────────────────────────────────────── */

export const factOrders = pgTable(
  'fact_orders',
  {
    orderId: text('order_id').primaryKey(),
    orderTs: timestamp('order_ts', { withTimezone: true }).notNull(),
    orderDate: date('order_date').notNull(),
    storeId: text('store_id').references(() => dimStore.storeId),
    tenant: text('tenant').notNull().default('trends'),
    affiliateId: text('affiliate_id').notNull(),
    /** §27.4 — SHA-256 + server-side salt. Never plaintext. */
    customerId: text('customer_id'),
    isNewCustomer: boolean('is_new_customer'),
    status: text('status').notNull(),
    units: integer('units'),
    grossValue: numeric('gross_value', { precision: 12, scale: 2 }),
    discountAmount: numeric('discount_amount', { precision: 12, scale: 2 }).default('0'),
    couponAmount: numeric('coupon_amount', { precision: 12, scale: 2 }).default('0'),
    couponCode: text('coupon_code'),
    netValue: numeric('net_value', { precision: 12, scale: 2 }),
    paymentMethod: text('payment_method'),
    appVersion: text('app_version'),
    sdkVersion: text('sdk_version'),
    platform: text('platform'),
    /**
     * A3 (open assumption) — the `avis_base_view` status enum is undocumented.
     * Until resolved we store both variants: `status_confirmed` records whether
     * this row counted as confirmed under the current mapping, so the UI can
     * show both figures and label the ambiguity rather than pick one silently.
     */
    statusConfirmed: boolean('status_confirmed'),
    source: text('_source').notNull(),
    ingestedAt: timestamp('_ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('fact_orders_date_store_idx').on(t.orderDate, t.storeId),
    index('fact_orders_customer_idx').on(t.customerId),
  ],
);

/* ── §7.3 Funnel ─────────────────────────────────────────────────────────── */

export const factFunnelDaily = pgTable(
  'fact_funnel_daily',
  {
    dateKey: date('date_key').notNull(),
    storeId: text('store_id').notNull().default(''),
    tenant: text('tenant').notNull().default('trends'),
    platform: text('platform').notNull().default(''),
    appVersion: text('app_version').notNull().default(''),
    step: text('step').notNull(),
    stepOrder: integer('step_order').notNull(),
    eventCount: bigint('event_count', { mode: 'number' }).notNull(),
    sessionCount: bigint('session_count', { mode: 'number' }).notNull(),
    userCount: bigint('user_count', { mode: 'number' }),
    /**
     * §16.9 — `false` is how a missing event renders as "not instrumented"
     * rather than zero. Set when the event is absent from the GTM container,
     * not merely absent from the data.
     */
    isInstrumented: boolean('is_instrumented').notNull().default(true),
  },
  (t) => [
    primaryKey({
      columns: [t.dateKey, t.storeId, t.platform, t.appVersion, t.step],
    }),
  ],
);

/* ── §16.4 Discovered journeys ───────────────────────────────────────────── */

/**
 * One row per distinct ordered event sequence, with the exact number of
 * sessions that took it.
 *
 * `fact_funnel_daily` above cannot answer "what do people actually do": it is a
 * per-event daily aggregate, so it knows how many sessions reached
 * `begin_checkout` and nothing about how they got there. Reconstructing paths
 * from it means multiplying edge probabilities, which assumes step 5 is
 * independent of step 2 — the assumption a journey exists to disprove.
 *
 * Storing whole paths keeps every session count exact. The row count stays
 * bounded because the extraction keeps only paths above a session floor; the
 * long tail is summarised into a single `(other)` row rather than dropped, so
 * the totals still reconcile against `fact_funnel_daily`.
 */
export const factJourneyPath = pgTable(
  'fact_journey_path',
  {
    dateKey: date('date_key').notNull(),
    platform: text('platform').notNull().default(''),
    tenant: text('tenant').notNull().default('trends'),
    /** Stable hash of `path`, because the path itself is too long for a key. */
    pathHash: text('path_hash').notNull(),
    /** Events in order, '>'-joined, consecutive duplicates already collapsed. */
    path: text('path').notNull(),
    stepCount: integer('step_count').notNull(),
    sessions: bigint('sessions', { mode: 'number' }).notNull(),
    convertedSessions: bigint('converted_sessions', { mode: 'number' }).notNull().default(0),
    revenue: numeric('revenue', { precision: 16, scale: 2 }),
    /** First step to last, where the export carried timestamps. */
    medianSeconds: integer('median_seconds'),
  },
  (t) => [
    primaryKey({ columns: [t.dateKey, t.platform, t.pathHash] }),
    index('fact_journey_path_date_idx').on(t.dateKey),
    index('fact_journey_path_sessions_idx').on(t.sessions),
  ],
);

/**
 * Per-event totals, and the only thing that decides what counts as an outcome.
 *
 * `revenueSessions` comes from GA4's own `ecommerce.purchase_revenue`, so
 * "which event ends a converting journey" is read from the data rather than
 * from a hardcoded list containing `purchase`. A second checkout flow under a
 * different event name is then found rather than silently excluded.
 */
export const factEventNode = pgTable(
  'fact_event_node',
  {
    dateKey: date('date_key').notNull(),
    platform: text('platform').notNull().default(''),
    tenant: text('tenant').notNull().default('trends'),
    event: text('event').notNull(),
    sessions: bigint('sessions', { mode: 'number' }).notNull(),
    events: bigint('events', { mode: 'number' }).notNull(),
    revenueSessions: bigint('revenue_sessions', { mode: 'number' }).notNull().default(0),
    revenue: numeric('revenue', { precision: 16, scale: 2 }),
  },
  (t) => [primaryKey({ columns: [t.dateKey, t.platform, t.event] })],
);

/* ── §7.4 Scan events ────────────────────────────────────────────────────── */

export const factScanDaily = pgTable(
  'fact_scan_daily',
  {
    dateKey: date('date_key').notNull(),
    storeId: text('store_id').notNull().default(''),
    ean: text('ean').notNull(),
    result: text('result').notNull(), // found | not_found
    platform: text('platform').notNull().default(''),
    salesChannel: text('sales_channel'),
    scanCount: bigint('scan_count', { mode: 'number' }).notNull(),
    sessionCount: bigint('session_count', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.dateKey, t.storeId, t.ean, t.result, t.platform] }),
    index('fact_scan_daily_ean_idx').on(t.ean),
    index('fact_scan_daily_date_idx').on(t.dateKey),
  ],
);

/**
 * §16.5.1 — Rejected scan values are recorded, not discarded. Silently dropping
 * them replaces one blind spot with another.
 */
export const factScanRejectedDaily = pgTable(
  'fact_scan_rejected_daily',
  {
    dateKey: date('date_key').notNull(),
    storeId: text('store_id').notNull().default(''),
    reason: text('reason').notNull(), // EanRejectReason
    scanCount: bigint('scan_count', { mode: 'number' }).notNull(),
    sampleValues: text('sample_values').array(), // up to 5, for debugging
  },
  (t) => [primaryKey({ columns: [t.dateKey, t.storeId, t.reason] })],
);

/* ── §7.5 Catalogue ──────────────────────────────────────────────────────── */

export const factCatalogueGap = pgTable('fact_catalogue_gap', {
  ean: text('ean').primaryKey(),
  firstSeen: date('first_seen').notNull(),
  lastSeen: date('last_seen').notNull(),
  scanCount: bigint('scan_count', { mode: 'number' }).notNull().default(0),
  storesAffected: integer('stores_affected').notNull().default(0),
  /** A hypothesis (§20.3). The column name stays honest about that. */
  suspectedReason: text('suspected_reason'),
  reasonDirection: text('reason_direction'), // inbound | outbound
  status: text('status').notNull().default('new'),
  owner: text('owner'),
  resolvedOn: date('resolved_on'),
  notes: text('notes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const factCatalogueDaily = pgTable('fact_catalogue_daily', {
  dateKey: date('date_key').primaryKey(),
  totalScans: bigint('total_scans', { mode: 'number' }),
  totalFailed: bigint('total_failed', { mode: 'number' }),
  uniqueScans: bigint('unique_scans', { mode: 'number' }),
  uniqueFailed: bigint('unique_failed', { mode: 'number' }),
  uniqueCoverage: numeric('unique_coverage', { precision: 6, scale: 4 }),
  totalCoverage: numeric('total_coverage', { precision: 6, scale: 4 }),
  /** §18.5 — parsed from the bot's own stated %, for the reconcile assertion. */
  botStatedPct: numeric('bot_stated_pct', { precision: 6, scale: 4 }),
  /** NULL = the day is unreachable via Slack pagination (§18.3), not "no report". */
  reportGenerated: boolean('report_generated').default(true),
  source: text('_source').notNull(), // slack_bot | ga4_bq | unreachable
});

/* ── §7.7 Reserved — true coverage (MODULE_TRUE_COVERAGE) ────────────────── */

export const factCatalogueTruthDaily = pgTable(
  'fact_catalogue_truth_daily',
  {
    dateKey: date('date_key').notNull(),
    storeId: text('store_id').notNull().default(''),
    sapSkuCount: bigint('sap_sku_count', { mode: 'number' }),
    companionSkuCount: bigint('companion_sku_count', { mode: 'number' }),
    /** companion / sap — NOT scan-observed. Never let one become the other. */
    trueCoverage: numeric('true_coverage', { precision: 6, scale: 4 }),
    rraInventoryLagMinutes: integer('rra_inventory_lag_minutes'),
  },
  (t) => [primaryKey({ columns: [t.dateKey, t.storeId] })],
);

/* ── §7.6 App health, adoption, issues ───────────────────────────────────── */

export const factAppHealthDaily = pgTable('fact_app_health_daily', {
  dateKey: date('date_key').primaryKey(),
  sessions: bigint('sessions', { mode: 'number' }),
  crashedSessions: bigint('crashed_sessions', { mode: 'number' }),
  crashFreeRate: numeric('crash_free_rate', { precision: 6, scale: 4 }),
  sentryErrorCount: bigint('sentry_error_count', { mode: 'number' }),
  apiCallCount: bigint('api_call_count', { mode: 'number' }),
  apiErrorCount: bigint('api_error_count', { mode: 'number' }),
  apiErrorRate: numeric('api_error_rate', { precision: 6, scale: 4 }),
  paymentAttempts: bigint('payment_attempts', { mode: 'number' }),
  paymentSuccesses: bigint('payment_successes', { mode: 'number' }),
  paymentSuccessRate: numeric('payment_success_rate', { precision: 6, scale: 4 }),
  gcpErrorLogCount: bigint('gcp_error_log_count', { mode: 'number' }),
  appHealthScore: numeric('app_health_score', { precision: 5, scale: 2 }),
  /** component → {value, weight, included} — the score is always decomposable. */
  scoreComponents: jsonb('score_components'),
  missingComponents: text('missing_components').array(),
});

export const factApiLatency = pgTable(
  'fact_api_latency',
  {
    dateKey: date('date_key').notNull(),
    endpoint: text('endpoint').notNull(),
    p50Ms: integer('p50_ms'),
    p90Ms: integer('p90_ms'),
    p95Ms: integer('p95_ms'),
    p99Ms: integer('p99_ms'),
    callCount: bigint('call_count', { mode: 'number' }),
    errorCount: bigint('error_count', { mode: 'number' }),
    sloP95Ms: integer('slo_p95_ms'),
    /** A10 — SLOs are placeholders until confirmed. Alerting is gated on this. */
    sloConfirmed: boolean('slo_confirmed').notNull().default(false),
    /** real_user | synthetic — never blend the two series (§25). */
    source: text('_source').notNull().default('real_user'),
  },
  (t) => [primaryKey({ columns: [t.dateKey, t.endpoint] })],
);

export const factStoreAdoptionDaily = pgTable(
  'fact_store_adoption_daily',
  {
    dateKey: date('date_key').notNull(),
    storeId: text('store_id').notNull(),
    orders: integer('orders').default(0),
    revenue: numeric('revenue', { precision: 12, scale: 2 }).default('0'),
    scans: bigint('scans', { mode: 'number' }).default(0),
    scanSuccessRate: numeric('scan_success_rate', { precision: 6, scale: 4 }),
    sessions: bigint('sessions', { mode: 'number' }).default(0),
  },
  (t) => [primaryKey({ columns: [t.dateKey, t.storeId] })],
);

/** §4.4 — manually maintained / CSV-uploaded operational state. */
export const factStoreOps = pgTable('fact_store_ops', {
  storeId: text('store_id')
    .primaryKey()
    .references(() => dimStore.storeId),
  qrVmPlaced: boolean('qr_vm_placed'),
  qrVmVerifiedOn: date('qr_vm_verified_on'),
  qrVmProofUrl: text('qr_vm_proof_url'),
  staffTrained: boolean('staff_trained'),
  staffTrainedOn: date('staff_trained_on'),
  footfallDaily: integer('footfall_daily'),
  billsDaily: integer('bills_daily'),
  nocOwner: text('noc_owner'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const factIssues = pgTable('fact_issues', {
  issueKey: text('issue_key').primaryKey(), // e.g. NI-1726
  source: text('source').notNull(), // jira | slack_noc | tasks_sheet
  title: text('title').notNull(),
  priority: text('priority'),
  status: text('status'),
  /**
   * Whether the tracker considers the issue done — from Jira's `statusCategory`
   * (todo/indeterminate/done), the only cross-workflow-reliable signal. A literal
   * `status = 'Done'` check misses `Closed`, `Released on PROD`, `Rejected`…, and
   * `resolutiondate` is only set on ~17% of closed issues here, so neither is
   * trustworthy for "open" — this flag is.
   */
  isDone: boolean('is_done').notNull().default(false),
  workstream: text('workstream'),
  journeyStep: text('journey_step'),
  storeCode: text('store_code'),
  assignee: text('assignee'),
  createdAt: timestamp('created_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  url: text('url'),
});

/* ── §7.10 Reference tables ──────────────────────────────────────────────── */

export const dimEnvironment = pgTable('dim_environment', {
  envKey: text('env_key').primaryKey(), // production only — see §0
  displayName: text('display_name').notNull(),
  urlTemplate: text('url_template').notNull(), // may contain {store_id}
  purpose: text('purpose'),
  isCustomerFacing: boolean('is_customer_facing').notNull().default(false),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastCheckStatus: text('last_check_status'), // ok | unreachable | unknown
});

export const dimTestEan = pgTable('dim_test_ean', {
  ean: text('ean').primaryKey(),
  expectedResult: text('expected_result').notNull(), // found | not_found
  feature: text('feature'), // scan_and_go | size_finder | null
  source: text('source'), // slack_verified | store_visit
  sourceNote: text('source_note'),
  verifiedOn: date('verified_on'),
  lastActualResult: text('last_actual_result'), // from fact_scan_daily
  lastActualOn: date('last_actual_on'),
  isCanary: boolean('is_canary').notNull().default(true),
});

export const factStoreVisitAudit = pgTable('fact_store_visit_audit', {
  visitId: bigserial('visit_id', { mode: 'number' }).primaryKey(),
  visitDate: date('visit_date').notNull(),
  storeId: text('store_id').references(() => dimStore.storeId),
  storeLabel: text('store_label'), // as written in the visit report
  auditor: text('auditor'),
  itemsScanned: integer('items_scanned').notNull(),
  itemsFailed: integer('items_failed').notNull(),
  sampledCoverage: numeric('sampled_coverage', { precision: 6, scale: 4 }).generatedAlwaysAs(
    sql`((items_scanned - items_failed)::NUMERIC / NULLIF(items_scanned, 0))`,
  ),
  qrVmObserved: boolean('qr_vm_observed'),
  staffAware: boolean('staff_aware'),
  failedEans: text('failed_eans').array(),
  notes: text('notes'),
  sourcePermalink: text('source_permalink'),
});

/* ── §7.8 Operational tables ─────────────────────────────────────────────── */

export const etlRunLog = pgTable(
  'etl_run_log',
  {
    runId: bigserial('run_id', { mode: 'number' }).primaryKey(),
    connector: text('connector').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull(), // success | warn | fail
    rowsIngested: bigint('rows_ingested', { mode: 'number' }),
    bytesScanned: bigint('bytes_scanned', { mode: 'number' }),
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    assertions: jsonb('assertions'),
    error: text('error'),
    /**
     * True when the rows came from fixtures rather than the upstream source.
     *
     * Seeding exists so the load path is exercised before the first real
     * credential arrives — otherwise the first production run is also the
     * first time `load()` has ever executed. This flag is what stops the
     * result being indistinguishable from live data afterwards: the serving
     * layer reads it and reports the mart as `fixture`, whatever is in it.
     */
    seeded: boolean('seeded').notNull().default(false),
  },
  (t) => [index('etl_run_log_connector_idx').on(t.connector, t.startedAt)],
);

/**
 * §9.5 — data sources configured from the UI.
 *
 * The `.env` model required a redeploy to add a credential, which meant a NOC
 * lead handed a Slack token could do nothing with it without a developer. This
 * is the table behind "Add a data source".
 *
 * `config` holds the non-secret settings — project ids, channel ids, dataset
 * names — as plain JSON, because they are useful to read in a psql prompt when
 * something is wrong. `secrets` holds AES-256-GCM ciphertext, one entry per
 * secret field, and nothing decrypts it but the app. `secretPreview` is the
 * masked form the UI is allowed to show; the plaintext is never sent back to a
 * browser under any circumstance.
 */
export const dataSource = pgTable(
  'data_source',
  {
    sourceId: bigserial('source_id', { mode: 'number' }).primaryKey(),
    /** A `SOURCE_TYPES` id — bigquery, slack, postgres… */
    type: text('type').notNull(),
    /** What a human called it. Two BigQuery projects need two names. */
    name: text('name').notNull(),
    config: jsonb('config').notNull().default({}),
    secrets: jsonb('secrets').notNull().default({}),
    secretPreview: jsonb('secret_preview').notNull().default({}),
    /** Disabled sources keep their credentials but are skipped by the scheduler. */
    enabled: boolean('enabled').notNull().default(true),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastTestDetail: text('last_test_detail'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('data_source_type_name_key').on(t.type, t.name)],
);

export const aiInsight = pgTable('ai_insight', {
  insightId: bigserial('insight_id', { mode: 'number' }).primaryKey(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(), // daily_brief | anomaly | rca_hint | answer
  scope: text('scope'), // module or metric id
  severity: text('severity'), // info | watch | act
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** [{metric_id, value, window, delta}] — an insight that can't cite is a bug. */
  citedMetrics: jsonb('cited_metrics').notNull(),
  model: text('model').notNull(),
  /** §28.7 — model + prompt version on every row, for reproducibility. */
  promptVersion: text('prompt_version'),
  dismissedBy: text('dismissed_by'),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
});

/**
 * §12 — Thresholds and SLOs live in the database, not in env, so ops can tune
 * them without a deploy.
 */
/**
 * §4.10 — a saved board layout.
 *
 * Kept in the database rather than in a config file for the same reason
 * `data_source` is: the person who wants a tile on the NOC wall is not the
 * person who can deploy. `board` is a name, so a NOC board and a leadership
 * board are two rows sets rather than two builds.
 */
export const dashboardWidget = pgTable(
  'dashboard_widget',
  {
    widgetId: text('widget_id').primaryKey(),
    board: text('board').notNull().default('default'),
    kind: text('kind').notNull(),
    /** Exactly one of these is set; the other is null. */
    metricId: text('metric_id'),
    seriesId: text('series_id'),
    title: text('title'),
    /** Null means "use the threshold from app_setting", not "no target". */
    target: numeric('target', { precision: 16, scale: 4 }),
    size: text('size').notNull().default('sm'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dashboard_widget_board_idx').on(t.board, t.position)],
);

export const appSetting = pgTable('app_setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** §5.5 — gap reason taxonomy, config-driven rather than hard-coded. */
/**
 * §18.5 / §20.3 — the defect table from the hourly Tatsu sync report.
 *
 * `fact_catalogue_daily` carries the coverage headline, one row a day. This
 * carries the reasons underneath it: one row per (report, pipeline, direction,
 * error type). The difference is "94% coverage" versus "2,742 SKUs failed
 * outbound because an EAN is already assigned to another item code" — a slide
 * number against a work queue.
 */
export const factCatalogueDefect = pgTable(
  'fact_catalogue_defect',
  {
    reportDate: date('report_date').notNull(),
    /** The bot posts hourly; each report is its own row, not an overwrite. */
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),
    pipeline: text('pipeline').notNull(),
    direction: text('direction').notNull(), // inbound | outbound
    errorType: text('error_type').notNull(),
    count: integer('count').notNull(),
    /** Null where the bot's error string maps to no §20.3 reason yet. */
    gapReason: text('gap_reason'),
  },
  (t) => [
    primaryKey({ columns: [t.reportDate, t.reportedAt, t.pipeline, t.direction, t.errorType] }),
    index('fact_catalogue_defect_date_idx').on(t.reportDate),
    index('fact_catalogue_defect_reason_idx').on(t.gapReason),
  ],
);

export const dimGapReason = pgTable('dim_gap_reason', {
  reason: text('reason').primaryKey(),
  label: text('label').notNull(),
  direction: text('direction'), // inbound | outbound
  knownFrequency: text('known_frequency'),
  sortOrder: integer('sort_order').notNull().default(100),
});

/**
 * §5.4 — Catalogue *completeness* (distinct from scan-observed coverage).
 *
 * Sourced from the `sng-prod.catalogue_health` dataset (Geckoboard-style summary
 * tables). One row per (snapshot day × pipeline): OVERALL / SAP / AJIO CE. The
 * per-attribute fill rates and the quality-issue list are carried as jsonb rather
 * than their own tables — they are small, always read together with the summary,
 * and never joined on.
 */
export const factCatalogueHealth = pgTable(
  'fact_catalogue_health',
  {
    snapshotDate: date('snapshot_date').notNull(),
    pipeline: text('pipeline').notNull(), // OVERALL | SAP | AJIO CE
    totalCatalog: bigint('total_catalog', { mode: 'number' }),
    completeCatalog: bigint('complete_catalog', { mode: 'number' }),
    missingCatalog: bigint('missing_catalog', { mode: 'number' }),
    /** Ratios 0–1, so they render like every other §5 ratio. */
    completionPct: numeric('completion_pct', { precision: 6, scale: 4 }),
    fillRatePct: numeric('fill_rate_pct', { precision: 6, scale: 4 }),
    mediaCoveragePct: numeric('media_coverage_pct', { precision: 6, scale: 4 }),
    /** [{attribute, fillRate (0–1), missing}] — per attribute, this pipeline. */
    attributes: jsonb('attributes'),
    /** [{metric, value}] — quality issues; populated on the OVERALL row only. */
    quality: jsonb('quality'),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
    source: text('_source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapshotDate, t.pipeline] })],
);

export const schema = {
  factCatalogueHealth,
  factCatalogueDefect,
  dimStore,
  dimProduct,
  dimDate,
  dimEnvironment,
  dimTestEan,
  dimGapReason,
  factOrders,
  factFunnelDaily,
  factScanDaily,
  factScanRejectedDaily,
  factCatalogueGap,
  factCatalogueDaily,
  factCatalogueTruthDaily,
  factAppHealthDaily,
  factApiLatency,
  factStoreAdoptionDaily,
  factStoreOps,
  factIssues,
  factStoreVisitAudit,
  etlRunLog,
  dataSource,
  aiInsight,
  appSetting,
};
