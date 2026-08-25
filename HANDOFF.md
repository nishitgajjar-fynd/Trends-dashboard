# HANDOFF — Companion Dashboard

Handoff for the next coding agent. Written 2026-08-25. Companion is Reliance Trends'
in-store "Scan & Go" app. This doc is self-contained; a shorter reference lives in
`DASHBOARD_INFO.md`.

---

## 1. Objective & intended users
**Objective:** one dashboard that answers *"is Companion healthy today, and if not,
where?"* across business (orders/revenue), funnel/journey, store adoption, catalogue
health, app/tech health, and engineering issues — production only, Companion/Scan&Go
scope only (not Kiosk or other Impetus products).

**Intended users:**
- **Product & Eng leads** — the Hub + AI daily brief before standup.
- **NOC / Ops** — Stores page (dark-store call list, compliance).
- **Category/Catalogue** — Catalogue page (coverage, missing EANs).
- **Leadership** — Board (custom tiles), Sales, state-level rollups.
Roles: `exec | pm | eng | ops` (open-access mode until an IdP is provisioned).

---

## 2. Current implementation status
**Fully built and mostly live.** Every card has a fixture fallback and is visibly
marked when fixture-backed. As of now:
- **Live:** orders, e-GMV, GA4 funnel/scans/journeys, **store master (BigQuery)**,
  catalogue health (matches the team's Geckoboard to the decimal), catalogue gaps, Jira P0s.
- **Fixture (known external blockers):** Slack (Tatsu daily report), Sentry (crash-free),
  GA4 Data API cross-check, API latency/SLOs, Loyalty, Amplitude.
- **AI Insights:** code complete; **blocked only by an invalid `ANTHROPIC_API_KEY`** (401).

---

## 3. Tech stack & architecture
- **Next.js 15.5 (App Router) / React 19 / TypeScript**, Tailwind-style CSS variables.
- **Drizzle ORM** over **Postgres (Supabase**, Mumbai `ap-south-1`, **session pooler
  port 5432**, `prepare:false`, `max:1`).
- **BigQuery** (`sng-prod`, plus GA4 export project) is the **source of record**.
- **Two planes:**
  1. **ETL** (`scripts/etl.ts`, `lib/connectors/*`): extract → transform → assert → load.
     Runs **locally** with Google ADC, reads BigQuery, writes the Supabase **mart**.
  2. **Serving** (the Vercel app): reads the mart; needs only `DATABASE_URL` to display.
- **Connector lifecycle:** `BaseConnector` (`lib/connectors/base.ts`) with retry, an
  **assertion gate** (bad data keeps the last good snapshot), and a `run_log` that marks
  a run `seeded` when fixtures were written.
- **Deploy:** Vercel Hobby, region `bom1`. One daily cron (`/api/cron/tick`, 03:00 IST)
  runs due connectors; env-credential connectors (Jira/Slack/Sentry) can run on Vercel,
  `bq-*` connectors need ADC and run locally.

---

## 4. Commands
```bash
npm install                 # install
npm run dev                 # local dev (http://localhost:3000)
npm run build               # production build (also the main CI gate)
npm start                   # serve the build
npm run lint                # eslint
npm run typecheck           # tsc --noEmit
npm test                    # vitest run (unit/integration)
npm run test:watch          # vitest watch
npm run e2e                 # playwright (needs a running app)
npm run qa                  # lint + typecheck + test + build + e2e
# ETL (needs .env.local; bq-* need valid Google ADC):
npm run etl:status                                   # freshness of every connector
npm run etl:run -- <connector>                       # run one connector now
npm run etl:backfill -- bq-orders <start> <end> <chunkDays>
npm run db:push                                      # apply schema to the DB
gcloud auth application-default login                # refresh Google ADC when BQ 401s
```
**Local ETL setup:** create `.env.local` (see §13), then `gcloud auth
application-default login` for BigQuery.

---

## 5. Important files
| Path | Contains |
|---|---|
| `app/(dash)/*/page.tsx` | One page per domain (hub=`page.tsx`, sales, journey, journey/discovered, stores, catalogue, app-health, issues, insights, board, settings, connectors) |
| `app/api/cron/tick/route.ts`, `app/api/cron/[connector]/route.ts` | Scheduled + on-demand connector runs (Bearer `CRON_SECRET`) |
| `app/api/ask/route.ts` | Ask-the-data NL→SQL endpoint (read-only guard) |
| `lib/connectors/*` | One file per connector; `registry.ts` = active list, `scheduler.ts` = windows/SLAs, `base.ts` = lifecycle |
| `lib/services/modules.ts` | Per-domain data assembly (sales/journey/stores/catalogue/appHealth/issues + catalogueHealthData) |
| `lib/services/hub.ts` | Hub aggregation: the 6 health lights, anomalies, RCA, headline |
| `lib/services/scope.ts` | Turns filters into a store-id allow-list + platform predicate |
| `lib/data/repository.ts` | `tryLive()` wrapper: live query → fixture fallback with state |
| `lib/metrics/registry.ts` | The §5 metric contract (id, label, formula, source, grain) |
| `lib/metrics/compute.ts` | Store/state rollups, funnel aggregation, safe arithmetic |
| `lib/ai/{brief,prompts,context,journey-narrative,rca,sql-guard}.ts` | AI layer |
| `lib/db/{schema,settings,client}.ts` | Drizzle schema, DB-backed settings + AI guardrails |
| `lib/config/index.ts` | All env reads in one typed object |
| `fixtures/*` | Fixture data + shapes for every mart table |
| `components/filters/FilterBar.tsx` | URL-driven filter bar (client) |
| `components/charts/StoreMap.tsx` | India store map (SVG) |
| `.env.example` | Every env var the code reads (a test enforces this) |
| `DASHBOARD_INFO.md` | Compact project reference |

---

## 6. Data sources, schemas, date ranges, filters, KPIs
### Sources (BigQuery `sng-prod` unless noted) → mart → connector
| Domain | BQ source | Mart table | Connector |
|---|---|---|---|
| Orders | `sng_analytics_dwh.avis_base_view` (bag-grain; grouped to order) | `fact_orders` | `bq-orders` |
| GA4 funnel | `fynd-jio-impetus-non-prod.analytics_524294430` | `fact_funnel_daily` | `bq-ga4-events` |
| GA4 scans | same GA4 export | `fact_scan_daily` | `bq-ga4-scans` |
| GA4 journeys | same GA4 export | `fact_journey_path` | `bq-ga4-journeys` |
| **Store master** | `orbis_pipe_dwh.orbis_store` (JSON CDC, `company_id=1`) | `dim_store` | `bq-store-master` |
| Catalogue health | `catalogue_health.{geckoboard_summary_v2,attribute_fill_rate_v2,catalog_quality_summary_v2}` | `fact_catalogue_health` | `bq-catalogue-health` |
| Catalogue gaps | GA4 scans × master | `fact_catalogue_gap` | `catalogue-gap-register` |
| Issues | Jira `gofynd.atlassian.net` (label-scoped to Companion) | `fact_issues` | `jira` |
| Catalogue daily (Tatsu) | Slack report | `fact_catalogue_daily` | `slack-catalogue-report` *(empty — Slack unconfigured)* |

**Key IDs:** Companion prod affiliate `6978c8d5b2f0316521d38b37`; GA4 property `524294430`;
Companion fires **custom** events (`scan_go_*`, `payment_success`) — **not** GA4 `purchase`.

### Schemas (main tables, see `lib/db/schema.ts`)
- `dim_store(store_id PK-text, store_code, store_name, city, state, region, tenant,
  companion_live, activated_on, lat, lon)` — `store_id` = orbis `uid`.
- `fact_orders(order_id PK, order_ts, order_date, store_id→dim_store, tenant, affiliate_id,
  customer_id, is_new_customer, status, units, gross_value, discount/coupon, net_value,
  payment_method, platform, ...)`.
- `fact_catalogue_health(snapshot_date, pipeline, total/complete/missing_catalog,
  completion_pct, fill_rate_pct, media_coverage_pct, attributes jsonb, quality jsonb)`.
- `app_setting(key PK, value jsonb, ...)` — thresholds + `ai_guardrails`.
- `etl_run_log(run_id, connector, status, rows_ingested, bytes_scanned, window, seeded)`.

### Date ranges / windows
- **Hub:** trailing **28 days**, ending **yesterday** (today is partial), compared with the
  previous 28. Labeled under the title.
- **Sales:** trailing 90d default. **Catalogue:** fixed 2026-07-30→08-12 baseline default.
- **Journey/Stores/AppHealth:** trailing 28d default.
- All windows are **IST calendar days**; "yesterday" anchoring is deliberate.

### Filters (URL-driven, shareable — `FilterBar` + `lib/params/filters.ts` + `scope.ts`)
`start`, `end`, quick presets (7/28/90d), `store` (code or id), `city`, `state`,
`platform` (ios/android), `compare` (prev_period/...). A filter matching nothing renders
as "no match", distinct from "no data".

### KPI definitions (selected; full list in `lib/metrics/registry.ts`)
- **orders** = distinct completed order_ids in window. **egmv/net_revenue** = Σ net_value
  (₹; net==egmv until discounts/coupons are tracked). **aov** = egmv/orders.
- **stores_live** = rows in `dim_store` (all Trends stores, `company_id=1`).
- **stores_active** = stores with ≥1 order **in the selected window** (window-based, not 7d).
- **stores_dark** = live stores with 0 orders in the window.
- **daily_order_compliance** = of active stores, fraction that ordered on the window's last day.
- **unique_coverage / total_coverage** = scan-observed coverage from `fact_scan_daily`.
- **catalogue_completion/fill_rate/media_coverage** = from `fact_catalogue_health` (Geckoboard tables).
- **payment_success_rate** = payment_success ÷ (payment_success + payment_failure).
- **session_conversion** = orders ÷ sessions. **p0_open** = open P0 Jira issues (Companion labels).

---

## 7. UI / design requirements & references
- **Dark theme**, CSS variables (`--color-ion` accent, `--color-alert`/`--color-warn`/
  `--color-scan` for red/amber/green, `--surface`, `--color-edge`). Indian numbering
  (₹, lakh/crore) via `lib/format/currency.ts`. IST throughout.
- **Hub** = 6 domain **traffic-light** cards (green/amber/red) + "today vs previous"
  KPI grid + AI brief + top risks. Light color = the domain's *worst* metric, which for
  **Stores** (color=compliance) and **App** (color=health score) differs from the printed number.
- Every fixture/stale/missing card is **badged**; numbers are never silently zeroed.
- Filters live in a bar under each module header; the URL is the source of truth.
- **Screenshots:** shared during the session (Hub, Catalogue, Journey, Stores, the team's
  Geckoboard "Trends Catalogue Health Dashboard V2"). Not committed to the repo — ask the
  product owner for the Geckoboard share link; catalogue-health numbers must match it.

---

## 8. Decisions made & rejected alternatives
- **Store master = BigQuery `orbis_store` (company_id=1)**, not the Google Sheet. Rejected:
  the sheet (reference-only) and `sng_analytics_dwh.store_master` (only 2/425 order stores
  joined). `orbis_store.uid` matches order store_id **425/425**. **Chose Option A**:
  `stores_live` = every Trends store (rejected Option B: Companion-enabled subset only).
- **Active/dark follow the selected window** (rejected the fixed 7-day lookback, which made
  the window filter appear broken).
- **Catalogue health reads the BQ tables directly** (rejected pulling from Geckoboard the
  product — no clean API; scraping the share link is fragile). Same data either way.
- **AI guardrails in the DB, editable at `/settings`** (rejected in-code-only and a static
  markdown file) so a PM can tune rules with no redeploy.
- **Removed unwired/fixture catalogue cards** (store-visit audited, true coverage, per-store
  coverage, resolved-7d, daily-report-health, coverage-measurements section, store×coverage
  table, store-visit audits) instead of leaving confusing placeholders.
- **Hidden (not deleted) never-instrumented funnel steps** (Product viewed, Payment info
  added) so metric formulas/issue refs stay valid.
- **AI context numbers are rounded** to 4dp (rejected weakening the PII guard) to stop a
  false-positive Aadhaar match on unrounded floats.

---

## 9. Files changed during this conversation
Commits on `NISHIT` (newest first): `d8a024f dc…` → see `git log`. Files touched:
```
.env.example                              app/(dash)/catalogue/page.tsx
app/(dash)/journey/page.tsx               app/(dash)/page.tsx
app/(dash)/settings/page.tsx              app/(dash)/settings/actions.ts        (new)
app/api/ask/route.ts                      components/charts/StoreMap.tsx
components/settings/GuardrailsEditor.tsx  (new)
fixtures/business.ts                      lib/ai/brief.ts
lib/ai/context.ts                         lib/ai/journey-narrative.ts
lib/ai/prompts.ts                         lib/config/index.ts
lib/connectors/bq-store-master.ts         (new)
lib/connectors/registry.ts                lib/connectors/scheduler.ts
lib/data/repository.ts                    lib/db/settings.ts
lib/metrics/compute.ts                    lib/metrics/registry.ts
lib/services/hub.ts                       lib/services/modules.ts
tests/kpi-coverage.test.ts                tests/metrics.test.ts
DASHBOARD_INFO.md (new)  HANDOFF.md (new)  CLAUDE_TRANSCRIPT.md (new)
```
Notable commits: `fa65764` order-backfill FK fix + scan-strip removal · `79efcde`
BigQuery store master · `7170357` window-based active/dark · `0a2a363` hydration/filter
fix · `fbb42be` AI guardrails · `494f3c5` AI PII rounding.

---

## 10. Known bugs, incomplete work, technical debt
- **AI Insights blocked:** `ANTHROPIC_API_KEY` returns **401 invalid**. Code is correct —
  the key value is wrong/revoked. Verify with a `curl` to the Messages API; re-add a fresh
  key (watch for trailing newline when pasting). Until then the brief stays deterministic.
- **`connectors-live.test.ts` is non-hermetic:** with `.env.local` it hits prod and its
  seed path **writes fixtures into the prod mart** (once required a full rebuild). Only the
  env-doc subtest is safe without a DB. **Make these tests hermetic.**
- **Fixture blockers unresolved (need external access):** Slack bot token (Tatsu daily
  report), Sentry token (crash-free/app-health), GA4 Data API service account, latency SLOs.
- **`daily_order_compliance` semantics** shifted with window-based active — sensible but
  worth a product review.
- **Google ADC expires every few days** — local ETL needs periodic re-auth.
- **`store_master` (sng_analytics_dwh)** exists but is the *wrong* store table — do not use.
- **Two Vercel hostnames** were seen (`trends-dashboard-nishit` and `-nishit1`); confirm
  which is production and that it deploys `NISHIT`.
- Minor: pre-existing eslint unused-var warnings (`minutesSince`, `_w`, `_nodes`).

---

## 11. Prioritized next steps
1. **Fix the AI key** (curl-test, re-add) → AI brief/RCA/Ask-the-data go live on Sonnet 5.
2. **Make `connectors-live.test.ts` hermetic** (guard the seed path; never write prod).
3. **Wire the fixture blockers** as tokens arrive: Slack → Sentry → GA4 API → latency.
4. **Confirm the production Vercel URL/branch** and set `CRON_SECRET`, `JIRA_*` in Vercel
   so the daily cron refreshes Jira automatically.
5. **Product review** of Option-A store semantics + `daily_order_compliance`.
6. Schedule/automate `bq-*` refreshes (currently local-only due to ADC).

---

## 12. Expected behavior & acceptance criteria
- **Numbers reconcile to BigQuery.** Verified this session: orders **7,013**, e-GMV
  **₹81.33 L** for 2026-07-28→08-24 match `avis_base_view` to the rupee.
- **Filters change the numbers** (state/city/store/window) and are shareable via URL; no
  React hydration errors in the console (a broken `<title>` previously disabled all filters).
- **Fixture cards are labeled**; empty marts show "connector not run", never 0.
- **Catalogue-health cards equal the Geckoboard** (28.45% / 40% / 25.78% at the Aug-17 snapshot).
- **Active/dark respond to the window** (7d≈294, 28d≈426, 90d≈634, All≈742).
- **AI degrades gracefully**: model outage → deterministic brief, never a broken page.
- **Build is green** and the unit suite passes.

---

## 13. Environment variables (names only — never commit values)
**Do not paste secret values anywhere.** Full list + comments in `.env.example`.
- **App:** `DATABASE_URL`, `DATABASE_URL_READONLY`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`,
  `AUTH_ALLOWLIST`, `CUSTOMER_ID_SALT`, `CRON_SECRET`, `TZ_DISPLAY`, `DEFAULT_ROLE`, `DEV_USER_EMAIL`.
- **Identity:** `COMPANION_PROD_AFFILIATE_ID`, `TOTAL_TRENDS_STORES`, `DEFAULT_TENANT`,
  `COMPANION_PROD_ENTRY_URL`, `COMPANION_PROD_API_HOST`, `DEFAULT_TEST_STORE_ID`.
- **BigQuery:** `GCP_PROJECT_ID`, `GCP_SA_KEY_JSON`, `GCP_USE_ADC`, `BQ_ORDERS_TABLE`,
  `BQ_ITEM_TABLE`, `BQ_STORE_TABLE`, `BQ_STORE_COMPANY_ID`, `BQ_CATALOGUE_HEALTH_DATASET`,
  `BQ_GA4_PROJECT`, `BQ_GA4_DATASET`, `BQ_MAX_BYTES_BILLED`, `BQ_ORDERS_CURRENCY_DIVISOR`,
  `BQ_CATALOGUE_PROJECT`, `BQ_CATALOGUE_DATASET`, `BQ_SNG_PROJECT`, `BQ_SNG_DATASET`,
  `BQ_CATALOGUE_MAX_ROWS`, `BQ_LATENCY_TABLE`, `BQ_DISCOVER_PROJECT`.
- **GA4:** `GA4_PROPERTY_ID`, `GA4_ACCOUNT_ID`, `GA4_API_ENABLED`.
- **Slack:** `SLACK_BOT_TOKEN`, `SLACK_CATALOGUE_CHANNEL`, `SLACK_ALERTS_CHANNEL`,
  `SLACK_NOC_CHANNEL`, `SLACK_DIGEST_CHANNEL`, `SLACK_WEBHOOK_URL`, `SLACK_SNAPSHOT_DIR`.
- **Sentry:** `SENTRY_ORG`, `SENTRY_AUTH_TOKEN`, `SENTRY_PROJECTS`.
- **Jira:** `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `JIRA_BOARD_ID`, `JIRA_EMAIL`,
  `JIRA_API_TOKEN`, `JIRA_COMPONENT_FILTER`, `JIRA_LABEL_FILTER`.
- **Sheets (legacy/reference):** `SHEET_STORE_MASTER_ID`, `SHEET_GA4_EVENTS_ID`, `SHEET_TASKS_ID`.
- **AI:** `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_BRIEF_CRON`.
- **Modules:** `MODULE_LOYALTY`, `BQ_LOYALTY_PROJECT`, `BQ_LOYALTY_DATASET`,
  `MODULE_AMPLITUDE`, `AMPLITUDE_API_KEY`, `MODULE_TRUE_COVERAGE`, `LATENCY_SYNTHETIC`.
- **Encryption:** `CREDENTIAL_KEY` (for `/connectors/sources` stored credentials).

---

## 14. Tests / checks already run (this session)
| Check | Result |
|---|---|
| `tests/kpi-coverage.test.ts` | **pass** (16) |
| `tests/metrics.test.ts` | **pass** (22, updated for window-based active/dark) |
| `tests/ai-scenarios.test.ts` | **pass** (34) |
| `tests/failure-paths.test.ts` | **pass** (36) |
| `tests/reconciliation.test.ts` | **pass** |
| `tests/connectors-live.test.ts -t "documents every environment variable"` (no DB) | **pass** (1; 29 skipped) |
| `npm run build` | **pass** (compiles clean) |
| Data reconciliation vs BigQuery (orders/e-GMV, 28d) | **exact match** |
| Store master join (orbis uid ↔ order store_id) | **425/425** |
| Filter/hydration fix | **verified in dev** (state → 195 live, 90d applies, no hydration error) |
_Not run: full `npm run e2e` (Playwright) and `npm run qa`. Recommend running before release._
