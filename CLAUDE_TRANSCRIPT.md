# Technical Transcript — Companion Dashboard session (2026-08-25)

Curated technical log of the work done with the coding agent. Chronological; each entry
is problem → diagnosis → fix, with the useful queries/root-causes preserved. Prose,
pleasantries, and generated Slack/report copy are omitted.

---

## A. Recovery: fixture pollution + failed order backfill
**Cause:** running `connectors-live.test.ts` with `.env.local` executed the seed path
against **prod Supabase**, writing `seeded=true` fixture rows into `fact_orders`,
`dim_store`, etc. → cards flipped to FIXTURE.
**Recovery:** cleared the seeded rows, reloaded stores, backfilled `bq-orders` Apr8→Aug25
in 14-day chunks. Two chunks (Jul1-14, Aug12-25) failed on insert.
**Root cause of the failed chunks:** `fact_orders.store_id` is a FK to `dim_store`; three
recently-onboarded stores (2857/2868/2869) weren't in the store master → whole batch
aborted. Verified: 3 of 425 Aug order stores missing from `dim_store`.
**Fix (`lib/connectors/bq-orders.ts`):** before inserting orders, upsert stub `dim_store`
rows (`onConflictDoNothing`) for every referenced store_id, so the FK always holds.
Result: `fact_orders` = 14,662 rows (Apr8→Aug25), zero seeded rows.
**Lesson (saved to memory):** never run `connectors-live.test.ts` against prod; the mart
is rebuildable from BigQuery (read-only).

## B. UI cleanup (Board / Journey / Catalogue)
- Removed the **Scan Strip** (Hub/Journey/Catalogue) + its API route + component.
- Board `DEFAULT_BOARD` (`lib/widgets/board.ts`): removed the fixture "Most-scanned missing
  EANs" tile (`catalogue.top_gaps`); series stays in the catalog for re-add.
- Journey funnel: hid never-instrumented steps **Product viewed** (`view_item`) and
  **Payment info added** (`add_payment_info`) via `hidden:true` (kept in `FUNNEL_STEPS` so
  metric formulas/issue refs stay valid). Fixture chain keeps them as calibration
  multipliers so visible-step counts are unchanged. Removed **Funnel by platform** table.
- Catalogue: removed fixture/unwired cards — store-visit audited, true coverage, resolved-7d,
  per-store coverage, daily-report-health (page-level filter `HIDDEN_KPI_IDS`; metrics stay
  in the registry so "every metric reaches a surface" test passes); removed the
  coverage-measurements section, store×coverage table, store-visit audits block; flipped
  "worst-filled" → **best-filled** attributes; suppressed the "Mart is empty" header warning.
- Catalogue completeness now shows **Completed products** (new metric
  `catalogue_complete_records` = `complete_catalog`) instead of completion%/incomplete-records.

## C. Catalogue-health data provenance
Verified our `fact_catalogue_health` (via `bq-catalogue-health`) reads the **same BQ tables**
the team's Geckoboard is built on: `sng-prod.catalogue_health.{geckoboard_summary_v2,
attribute_fill_rate_v2, catalog_quality_summary_v2}`. Numbers match to the decimal at the
**Aug-17 snapshot** (OVERALL: completion 28.45%, fill 40.00%, media 25.78%; total 15,432,134
/ complete 4,390,321 / missing 11,041,813). Geckoboard is not a data feed — we read its BQ
source. The top scan-coverage cards (91.5%/92.7%) are computed from **live `fact_scan_daily`**
but mislabeled with the Tatsu fixture source string (cosmetic).

## D. AI Insights enablement
- Model default → **`claude-sonnet-5`** (`lib/config/index.ts`); old `claude-sonnet-4-6`
  would silently 404 → deterministic.
- **DB-backed guardrails** (`lib/db/settings.ts`: `getAiGuardrails`/`setAiGuardrails`,
  key `ai_guardrails`, conservative default). Injected into all four system prompts via
  `withGuardrails()` (`lib/ai/prompts.ts`); `promptVersion` carries a guardrails hash.
- **Live editor** at `/settings` (`app/(dash)/settings/actions.ts` server action +
  `components/settings/GuardrailsEditor.tsx`), gated to the `settings` capability.
- **Enablement bug found:** with a valid key set, the model call failed —
  `assertNoPii` threw on an **Aadhaar-like number**. Root cause: an unrounded float in the
  context (`aov = 1159.678484243537`) whose 12-digit decimal tail matched the Aadhaar regex
  `\b\d{4}\s?\d{4}\s?\d{4}\b`. **Fix:** `roundDeep()` all context numbers to 4dp in
  `buildInsightContext` (`lib/ai/context.ts`).
- **Still blocked:** the provided `ANTHROPIC_API_KEY` returns **401 "invalid"** — the key
  value itself is wrong/revoked (curl-test; re-add fresh, no trailing newline).
- Enable path: set `ANTHROPIC_API_KEY` in Vercel (dashboard or `vercel env add …`) → redeploy.

## E. Store master → BigQuery (major change)
**Goal:** stop using the reference Google Sheet; use a BQ store list.
- `sng_analytics_dwh.store_master` (465 rows) — **uid mismatch**: only 2/425 order stores joined. Rejected.
- **`orbis_pipe_dwh.orbis_store`** (JSON CDC, 2,928 stores; 2,469 `company_id=1`) — its
  **`uid` matches order store_id 425/425**. Rich fields: name, store_code, address.city/state,
  lat_long, company_id. **Chosen.**
- New connector `lib/connectors/bq-store-master.ts`: latest CDC row per uid,
  `company_id='1'`, JSON_VALUE extraction, `REGION_BY_STATE` map (state→zone, since orbis has
  no region and the sheet left it blank), lat/lon from GeoJSON `[lon,lat]`. Upserts `dim_store`.
- Swapped into `registry.ts` (kept `sheets-store-master.ts` — its `mapHeaders`/`parseCsvLine`
  are used by a test); `scheduler.ts` snapshot+window; `repository.getStores` source label +
  freshness id; metric source string.
- Result: **2,468 stores**, region 100% populated, geo 100% populated (map works).
- **Decision (Option A):** `stores_live` = every Trends store (not the Companion-enabled subset).

## F. Active/dark stores + filter bug
- **Symptom:** "active" stuck at ~294 regardless of the window filter (7d/28d/90d/All
  identical). **Root cause:** active/dark computed on a hardcoded `inLast(7)` in
  `rollupStores`, ignoring the selected window.
- **Fix:** added `ordersInWindow` (Σ orders in the windowed data) to `StoreRollup`
  (`lib/metrics/compute.ts`); `active = ordersInWindow>0`, `dark = ordersInWindow===0`;
  `orders_per_active_store` divides by window length. Updated metric defs + two rollup tests.
  Result: 7d→294, 28d→426, 90d→634, All→742.
- **Filters "not working" — real root cause:** a **React hydration crash (#418)** on the
  page. The SVG store-map `<title>` interpolated 8 children; React 19 requires a single
  string child → hydration failed → FilterBar `onChange` handlers never attached (server-side
  URL filtering still worked, which masked it). **Dormant** until the store-master switch
  populated lat/long → the map rendered markers → the bad `<title>` fired.
  **Fix (`components/charts/StoreMap.tsx`):** wrap in a template literal (single child).
  Verified in dev: state → 195 live, 90d applies, no hydration error.

## G. Hub verification + window label
- Explained the 6 traffic lights (`lib/services/hub.ts`): Business=orders delta,
  Journey=session_conversion vs 2.5%, **Stores=compliance vs 70%** (not the dark count shown),
  Catalogue=coverage vs 97%, **App=health score <75** (not crash-free shown), Issues=P0 vs ½ ceiling.
- **Verified numbers vs BigQuery** (28d 2026-07-28→08-24): orders **7,013** and e-GMV
  **₹81.33 L (8,132,825)** match `avis_base_view` **exactly**.
- Added "Last 28 days · <start> → <end> IST · compared with the previous 28 days" under the
  Hub title; fixed the stale "Dark stores (7d)" → "Dark stores" caption.

---

## Useful queries (BigQuery, read-only)
```sql
-- Orders/e-GMV for a window (reconcile the Hub)
SELECT COUNT(DISTINCT order_id) orders, ROUND(SUM(billed_amount)) egmv
FROM `sng-prod.sng_analytics_dwh.avis_base_view`
WHERE DATE(state_date,'Asia/Kolkata') BETWEEN @start AND @end
  AND affiliate_id='6978c8d5b2f0316521d38b37' AND status='handed_over_to_customer';

-- Store master (latest CDC row per uid, Trends only)
WITH latest AS (
  SELECT JSON_VALUE(data,'$.uid') uid, JSON_VALUE(data,'$.store_code') code,
         COALESCE(JSON_VALUE(data,'$.display_name'),JSON_VALUE(data,'$.name')) name,
         JSON_VALUE(data,'$.address.city') city, JSON_VALUE(data,'$.address.state') state,
         ROW_NUMBER() OVER (PARTITION BY JSON_VALUE(data,'$.uid') ORDER BY _PARTITIONTIME DESC) rn
  FROM `sng-prod.orbis_pipe_dwh.orbis_store`
  WHERE JSON_VALUE(data,'$.company_id')='1')
SELECT * EXCEPT(rn) FROM latest WHERE rn=1 AND uid IS NOT NULL;

-- Catalogue health (Geckoboard source, latest snapshot)
SELECT pipeline, completion_percentage, fill_rate_percentage, media_coverage_percentage
FROM `sng-prod.catalogue_health.geckoboard_summary_v2`
WHERE snapshot_time=(SELECT MAX(snapshot_time) FROM `sng-prod.catalogue_health.geckoboard_summary_v2`);
```

## Gotchas the next agent will hit
1. `connectors-live.test.ts` + `.env.local` = seeds prod fixtures. Don't.
2. Google ADC expires (`invalid_grant`) → `gcloud auth application-default login`.
3. Hydration errors kill all interactivity — check the browser console first.
4. Hub light color ≠ printed number for Stores (compliance) and App (health score).
5. AI 401 = bad key value, not code.
