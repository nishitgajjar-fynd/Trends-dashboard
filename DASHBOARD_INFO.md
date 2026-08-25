# Companion Dashboard — Project Info

_A single-page reference for what this dashboard is, how it's built, where the data
comes from, and the things you must not forget. Last updated: 2026-08-25._

---

## 1. What it is
A **business + health dashboard for the Companion "Scan & Go" app** at Reliance Trends.
Companion is an in-store app: customer opens it → scans a garment tag → adds to bag →
pays → security tag is removed. It runs inside the AJIO host app via an SDK, across
Reliance Trends stores. **Production only.** Scope is Companion/Scan&Go — not Kiosk or
other Impetus products.

Pages: **Hub** (is Companion healthy today?), **Board** (custom tiles), **Sales**,
**Journey** + **Journeys found**, **Stores**, **Catalogue**, **App Health**, **Issues**,
**AI Insights**, **Connectors**, **Settings**.

---

## 2. GitHub & deployment
- **Repo:** `github.com/nishitgajjar-fynd/Trends-dashboard` (a fork)
- **Working branch:** **`NISHIT`** — all changes go here. Rule: _only touch NISHIT._
- **Hosting:** **Vercel (Hobby plan)**, region `bom1` (Mumbai). URL:
  `https://trends-dashboard-nishit.vercel.app`
- **Auto-deploy:** every `git push` to NISHIT triggers a Vercel redeploy (~1–2 min).
  Env-var changes only apply to *new* deployments → redeploy after editing them.
- **Push auth:** classic GitHub token with `repo` scope (password auth is dead).

---

## 3. Architecture
- **Next.js 15.5 / React 19** App Router · **Drizzle ORM** · **Postgres (Supabase**,
  Mumbai `ap-south-1`, **session pooler, port 5432**, `prepare:false`, `max:1`).
- **BigQuery is the source of record.** Supabase holds the **serving copy** (the "mart").
- **Two planes:**
  1. **ETL** (extract → transform → assert → load) runs **locally** with Google ADC,
     reads BigQuery, writes the Supabase mart.
  2. **Serving** (the Vercel app) only needs `DATABASE_URL` to read the mart.
- **Every card is fixture-backed by default and visibly marked**; filling a credential
  flips a connector from fixture → live, no code change.
- **Fixtures never silently replace data.** Empty query → "mart empty" state, not zeros.

---

## 4. Data sources (BigQuery, project `sng-prod` unless noted)
| Data | BQ source | Mart table | Connector |
|---|---|---|---|
| Orders | `sng_analytics_dwh.avis_base_view` | `fact_orders` | `bq-orders` |
| GA4 funnel/events | `fynd-jio-impetus-non-prod.analytics_524294430` (GA4 export) | `fact_funnel_daily` | `bq-ga4-events` |
| GA4 scans | same GA4 export | `fact_scan_daily` | `bq-ga4-scans` |
| GA4 journeys | same GA4 export | `fact_journey_path` | `bq-ga4-journeys` |
| **Store master** | `orbis_pipe_dwh.orbis_store` (company_id=1) | `dim_store` | **`bq-store-master`** |
| Catalogue health | `catalogue_health.*_v2` (the Geckoboard tables) | `fact_catalogue_health` | `bq-catalogue-health` |
| Catalogue gaps | GA4 scans × master | `fact_catalogue_gap` | `catalogue-gap-register` |
| Issues (P0) | Jira Cloud `gofynd.atlassian.net` | `fact_issues` | `jira` |

**Key IDs:** Companion prod affiliate = `6978c8d5b2f0316521d38b37`. GA4 property
`524294430` (single stream 13595026820). Companion fires **custom** events
(`scan_go_*`, `payment_success`, `order_confirmed`) — **not** GA4-standard `purchase`.

---

## 5. Store master (important — recently switched)
- Source is now **BigQuery `orbis_store`**, not the old Google Sheet (sheet was
  reference-only). Its `uid` **matches the order/scan `store_id` 1:1** (425/425).
- Scoped to **`company_id = 1` = Reliance Trends → 2,468 stores**, all with region
  (derived from state) and lat/long (map works now).
- **"stores_live" = every Trends store** (Option A), whether or not Companion is live
  there. So most stores read "dark" simply because they don't run Companion.
- **Active/dark follow the selected window** (not a fixed 7 days): 7d→294, 28d→426,
  90d→634, All→742 stores have ever transacted.

---

## 6. Live vs fixture (as of now)
- **Live:** orders, e-GMV, GA4 funnel, scans, journeys, store master, catalogue health
  (completion/fill/media, matches the team's Geckoboard to the decimal), catalogue gaps,
  Jira P0s.
- **Fixture / not wired (known blockers, need tokens/access):**
  - `slack-catalogue-report` (Tatsu daily report) → `fact_catalogue_daily` empty → needs
    **Slack bot token**. (Catalogue scan-coverage cards compute from live scans anyway.)
  - **Sentry** (crash-free / app health) → needs `SENTRY_AUTH_TOKEN`.
  - **GA4 Data API cross-check** → needs a service account on the GA4 property.
  - **API latency / SLOs** → source undecided (placeholders, gated).
  - **Loyalty**, **Amplitude** → module-gated + credentials.

---

## 7. AI Insights (§28)
- Four model features: **Daily brief**, **RCA hints**, **Ask-the-data (NL→SQL)**,
  **Journey narration**. Model **writes**, never decides (stats flag, rules pick cause).
- **Model:** default `claude-sonnet-5` (`AI_MODEL` overrides).
- **Enable:** set **`ANTHROPIC_API_KEY`** in Vercel env → redeploy. ⚠️ Currently the key
  returns **401 "invalid"** — the key value is wrong/revoked; test with `curl` and
  re-add a fresh key (watch for trailing newline/whitespace when pasting).
- **Guardrails:** house rules live in the DB (`app_setting.ai_guardrails`), **editable
  live at `/settings`**, no redeploy. They *add* to hard-coded safety rails (no PII,
  no fabricated numbers, read-only SQL) — can't disable them.
- Safety: context numbers are **rounded** before send (an unrounded float's 12-digit
  tail once tripped the Aadhaar-PII guard and blocked every generation).

---

## 8. Scheduling / refresh
- **One heartbeat cron** on Vercel: `/api/cron/tick` daily at **03:00 IST**; runs every
  connector that's past its freshness SLA. (Hobby plan = daily crons only.)
- On Vercel the cron can refresh **env-credential connectors** (Jira, Slack, Sentry) —
  **not** the `bq-*` ones, which need ADC and run **locally**.
- **Manual/local:** `npm run etl:run -- <connector>` · backfill:
  `npm run etl:backfill -- bq-orders <start> <end> <chunkDays>` · status: `npm run etl:status`.
- **External scheduler** (for sub-daily): `POST /api/cron/<connector>` with header
  `Authorization: Bearer <CRON_SECRET>`.

---

## 9. ⚠️ Very important / gotchas
1. **NEVER run `tests/connectors-live.test.ts` with `.env.local` exported against prod
   Supabase** — it **seeds fixtures** into the mart (indistinguishable from real rows,
   flips cards to FIXTURE). It happened once and required a full mart rebuild from BQ.
2. **Google ADC expires every few days** (`invalid_grant` / `invalid_rapt`). Re-auth:
   `gcloud auth application-default login`. BigQuery is **read-only** — we never write to it.
3. **The mart is fully rebuildable from BigQuery** — that's the safety net. `bq-orders`
   auto-creates stub `dim_store` rows for stores onboarded ahead of the master, so a
   window never silently drops orders on a foreign-key error.
4. **Filters are URL-driven** (shareable). A hydration crash (invalid SVG `<title>`)
   once disabled every filter control — fixed. If interactivity dies, check the browser
   console for React hydration errors first.
5. **Light color ≠ printed number** on Hub for *Stores* (color = compliance, not dark
   count) and *App* (color = health score, not crash-free).
6. **Never mention specific people by name** in any output.
7. Hub is a **28-day window** (labeled under the title), compared with the previous 28.

---

## 10. Current data snapshot (28-day window 2026-07-28 → 08-24)
Orders **7,013** · e-GMV **₹81.33 L** · Payment success **90.3%** · Unique coverage
**91.5%** · Active stores **426** · Dark **2,042** · Open P0 **6**. `fact_orders` holds
**14,662** rows (2026-04-08 → 08-25). All verified against BigQuery to the rupee.

---

## 11. Handy commands
```bash
# refresh one connector (needs .env.local + valid ADC for bq-*)
npm run etl:run -- jira
# rebuild the whole store list from BigQuery
npm run etl:run -- bq-store-master
# re-auth Google when BigQuery calls fail
gcloud auth application-default login
# tests (safe subset — NOT connectors-live against prod)
npx vitest run tests/kpi-coverage.test.ts tests/metrics.test.ts
# production build
npm run build
```
