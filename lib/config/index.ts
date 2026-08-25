/**
 * §12 — Configuration.
 *
 * Thresholds and SLOs deliberately do NOT live here: they live in the database
 * (`/settings`) so ops can tune them without a deploy. This file is identity,
 * endpoints, and credentials only.
 */
import { assertProductionOnly, PROD_AFFILIATE } from './env-guard';

const env = (k: string, fallback = ''): string => process.env[k] ?? fallback;

export const config = {
  // App
  nextAuthUrl: env('NEXTAUTH_URL'),
  databaseUrl: env('DATABASE_URL'),
  tzDisplay: env('TZ_DISPLAY', 'Asia/Kolkata'),

  // Identity (§0, §2.2)
  companionProdAffiliateId: env('COMPANION_PROD_AFFILIATE_ID', PROD_AFFILIATE),
  totalTrendsStores: Number(env('TOTAL_TRENDS_STORES', '1765')),
  defaultTenant: env('DEFAULT_TENANT', 'trends'),

  // App entry points (§2.7) — seeded into dim_environment
  prodEntryUrl: env(
    'COMPANION_PROD_ENTRY_URL',
    'https://www.ajio.com/companion_app?store_id={store_id}',
  ),
  prodApiHost: env('COMPANION_PROD_API_HOST', 'https://trends-companion-app.jiocommerce.io'),
  prodConsoleUrl: `https://platform.jiocommerce.io/company/1/application/${PROD_AFFILIATE}`,
  defaultTestStoreId: env('DEFAULT_TEST_STORE_ID', '617'),

  // BigQuery (§15, §16, §20)
  gcpProjectId: env('GCP_PROJECT_ID', 'sng-prod'),
  gcpSaKeyJson: env('GCP_SA_KEY_JSON'),
  bqOrdersTable: env('BQ_ORDERS_TABLE', 'sng-prod.sng_analytics_dwh.avis_base_view'),
  /**
   * §20.2 — the RBL structured catalogue. A *different* GCP project from the
   * Companion one, so it needs its own IAM grant (the same lesson as ADR-001).
   * Verified reachable and populated; `sng-prod` is not readable with the same
   * service account.
   */
  bqCatalogueProject: env('BQ_CATALOGUE_PROJECT', 'fynd-jio-impetus-prod'),
  bqCatalogueDataset: env('BQ_CATALOGUE_DATASET', 'rbl_catalog_structured_v7'),
  bqItemTable: env('BQ_ITEM_TABLE', 'sng-prod.orbis_pipe_dwh.item'),
  // §19 — the authoritative store master. Orbis CDC feed; `uid` matches the
  // order/scan store_id namespace 1:1 (unlike sng_analytics_dwh.store_master).
  bqStoreTable: env('BQ_STORE_TABLE', 'sng-prod.orbis_pipe_dwh.orbis_store'),
  // company_id that scopes the store master to Reliance Trends.
  bqStoreCompanyId: env('BQ_STORE_COMPANY_ID', '1'),
  /**
   * §5.4 — catalogue *completeness* dataset (Geckoboard summary tables). In
   * `sng-prod`, so it is reachable with the same credential as orders — unlike
   * the RBL master below, which lives in a different project.
   */
  bqCatalogueHealthDataset: env('BQ_CATALOGUE_HEALTH_DATASET', 'sng-prod.catalogue_health'),
  /**
   * The Scan-and-Go catalogue — the EAN master this build spent a long time
   * looking for.
   *
   * `rbl_catalog_structured_v7` was the best candidate until it was actually
   * read: 49,955 of 50,000 sampled rows carried `gtin_type = 'ALU'`, Reliance's
   * internal Article Level Unit code, which no customer can scan.
   * `analytics_boltic_sng.catalog` carries `seller_identifier`, and a sample
   * shows real GS1 barcodes — 8907844327152 (an Indian prefix), 4062452450730
   * (Puma). 6.52 M rows, 2.52 M distinct active barcoded EANs.
   *
   * Preferred over the RBL path when set, because a master of internal codes
   * cannot answer "was this scanned barcode in the catalogue".
   */
  bqSngProject: env('BQ_SNG_PROJECT', 'fynd-jio-impetus-prod'),
  bqSngDataset: env('BQ_SNG_DATASET', 'analytics_boltic_sng'),
  /**
   * A ceiling on the catalogue load, for environments that cannot hold 2.5 M
   * rows. `0` means no cap. When a cap truncates the master, the run records it
   * and the mart is served with the truncation stated — a silently short
   * catalogue would make every unlisted EAN look like a genuine gap (§20.3).
   */
  bqCatalogueMaxRows: Number(env('BQ_CATALOGUE_MAX_ROWS', '0')),
  /** §13.1 — UNKNOWN. Blocks Phase 3. Resolve with the SCHEMATA query in §16.1. */
  bqGa4Project: env('BQ_GA4_PROJECT'),
  /** §13.1 — UNKNOWN. GA4 default naming would be `analytics_524294430`. Do not assume. */
  bqGa4Dataset: env('BQ_GA4_DATASET'),
  bqMaxBytesBilled: env('BQ_MAX_BYTES_BILLED', String(50 * 1024 ** 3)),

  // GA4 (§17)
  ga4PropertyId: env('GA4_PROPERTY_ID', '524294430'),
  ga4AccountId: env('GA4_ACCOUNT_ID', '384216496'),

  // Slack (§18, Appendix B)
  slackBotToken: env('SLACK_BOT_TOKEN'),
  slackCatalogueChannel: env('SLACK_CATALOGUE_CHANNEL', 'C0AV6FU1YUU'),
  slackAlertsChannel: env('SLACK_ALERTS_CHANNEL', 'C0B0APYNZTQ'),
  slackNocChannel: env('SLACK_NOC_CHANNEL', 'C0BFJQDV05N'),
  slackDigestChannel: env('SLACK_DIGEST_CHANNEL'),
  /**
   * Incoming webhook, used when the bot token lacks `chat:write`.
   *
   * A webhook posts to exactly one channel chosen when it was created, so it
   * cannot replace `chat:write` — it can only keep alerting alive while the
   * reinstall is pending. Every post through it is labelled as such, because an
   * alert that silently went somewhere other than where it was addressed is
   * worse than one that failed loudly.
   */
  slackWebhookUrl: env('SLACK_WEBHOOK_URL'),
  /**
   * A directory of exported Slack JSON, read when the API refuses.
   *
   * A temporary bridge while `channels:history` is pending workspace approval.
   * Anything served from it is `cache`, never `live` — see slack-snapshot.ts.
   */
  slackSnapshotDir: env('SLACK_SNAPSHOT_DIR'),

  // Sentry (§21)
  sentryOrg: env('SENTRY_ORG', 'fynd-f7'),
  sentryAuthToken: env('SENTRY_AUTH_TOKEN'),
  sentryProjects: env('SENTRY_PROJECTS'),

  // Jira (§22)
  jiraBaseUrl: env('JIRA_BASE_URL', 'https://gofynd.atlassian.net'),
  jiraProjectKey: env('JIRA_PROJECT_KEY', 'NI'),
  jiraBoardId: env('JIRA_BOARD_ID', '11030'),
  jiraEmail: env('JIRA_EMAIL'),
  jiraApiToken: env('JIRA_API_TOKEN'),
  /** §13/A11 — the NI board is shared across four products. Unset means unfiltered. */
  jiraComponentFilter: env('JIRA_COMPONENT_FILTER'),
  /**
   * A11 — Companion has no Jira *component*; it is tracked by *labels*
   * (Companion*, Scan&GoPSE, SNG). This scopes the board to Companion + Scan&Go
   * and keeps Kiosk / other Impetus products out. Comma-separated label list.
   */
  jiraLabelFilter: env(
    'JIRA_LABEL_FILTER',
    'Companion,Companion_Web,companion-app,Companion_Android,Companion_iOS,Companion_SDK,companion_web,Scan&GoPSE,SNG',
  ),

  // Sheets (§19)
  sheetStoreMasterId: env('SHEET_STORE_MASTER_ID', '11eqPcFZnGm4mAG0SS5DvS_4o8IwcpJSMsXE_HorQreE'),
  sheetGa4EventsId: env('SHEET_GA4_EVENTS_ID', '1vbYPH919bSLRcYPz273X3Tz2QPOprXmhU4Mb8ehJwNY'),
  sheetTasksId: env('SHEET_TASKS_ID', '1cG0HJ-Ekw_0emZ2o47uqZ66Yq7W-l0ZC2ZONxUcddoQ'),

  // AI (§28)
  anthropicApiKey: env('ANTHROPIC_API_KEY'),
  aiModel: env('AI_MODEL', 'claude-sonnet-5'),
  aiBriefCron: env('AI_BRIEF_CRON', '0 8 * * *'),

  // Modules (§0)
  moduleLoyalty: env('MODULE_LOYALTY', 'false') === 'true',
  moduleAmplitude: env('MODULE_AMPLITUDE', 'false') === 'true',
  moduleTrueCoverage: env('MODULE_TRUE_COVERAGE', 'false') === 'true',
} as const;

/** Boot-time guard (§0). Called from instrumentation.ts so it runs once per process. */
export function validateConfig(): void {
  assertProductionOnly({
    COMPANION_PROD_AFFILIATE_ID: config.companionProdAffiliateId,
    COMPANION_PROD_ENTRY_URL: config.prodEntryUrl,
    COMPANION_PROD_API_HOST: config.prodApiHost,
    GCP_PROJECT_ID: config.gcpProjectId,
    BQ_ORDERS_TABLE: config.bqOrdersTable,
    BQ_ITEM_TABLE: config.bqItemTable,
    BQ_GA4_PROJECT: config.bqGa4Project,
    BQ_GA4_DATASET: config.bqGa4Dataset,
    GA4_PROPERTY_ID: config.ga4PropertyId,
    JIRA_BASE_URL: config.jiraBaseUrl,
    SENTRY_ORG: config.sentryOrg,
  });
}

export const isDbConfigured = (): boolean => config.databaseUrl.length > 0;
