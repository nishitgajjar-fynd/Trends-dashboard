/** §4.5 — Catalogue Health. */
import { catalogueModule, catalogueHealthData } from '@/lib/services/modules';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { StatePill } from '@/components/data-state';
import { ManhattanChart } from '@/components/charts/ManhattanChart';
import { TrendLine } from '@/components/charts/TrendLine';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { FilterBar } from '@/components/filters/FilterBar';
import { getFilterOptions } from '@/lib/services/filter-options';
import { formatCount, formatPct } from '@/lib/format/currency';
import { parseFilters, type RawParams } from '@/lib/params/filters';
import { getThresholds } from '@/lib/db/settings';
import { STORE_VISIT_AUDITS } from '@/fixtures/baselines';

export const dynamic = 'force-dynamic';

export default async function CataloguePage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const raw = await searchParams;
  // §18.7's backfill window is the default here: it is the range the catalogue
  // baseline is stated for, so an unfiltered load reproduces a known number.
  const filters = raw.start || raw.end ? parseFilters(raw, 14) : { ...parseFilters(raw, 14), window: { start: '2026-07-30', end: '2026-08-12' } };
  const [mod, t, options, health] = await Promise.all([
    catalogueModule(filters),
    getThresholds(),
    getFilterOptions(),
    catalogueHealthData(),
  ]);
  const {
    daily,
    gaps,
    ageBuckets,
    reasons,
    storeCoverage,
    auditedCoverage,
    reportGeneratedToday,
    gapReconciliation,
  } = mod.data;

  const openGaps = gaps
    .filter((g) => g.status !== 'resolved' && g.status !== 'wontfix')
    .sort((a, b) => b.scanCount - a.scanCount);

  const gapCols: Column<(typeof gaps)[number]>[] = [
    { key: 'ean', header: 'EAN', numeric: true, render: (g) => g.ean },
    { key: 'first', header: 'First seen', numeric: true, render: (g) => g.firstSeen },
    { key: 'last', header: 'Last seen', numeric: true, render: (g) => g.lastSeen },
    { key: 'scans', header: 'Scans', numeric: true, render: (g) => formatCount(g.scanCount) },
    { key: 'stores', header: 'Stores', numeric: true, render: (g) => formatCount(g.storesAffected) },
    {
      key: 'reason',
      header: 'Suspected reason',
      render: (g) => (
        <span title="A hypothesis from the catalogue-master join (§20.3), not a confirmed cause">
          {g.suspectedReason}
        </span>
      ),
    },
    { key: 'dir', header: 'Direction', render: (g) => g.reasonDirection ?? '—' },
    { key: 'status', header: 'Status', render: (g) => g.status },
    { key: 'owner', header: 'Owner', render: (g) => g.owner ?? <span className="text-[var(--color-warn)]">unowned</span> },
  ];

  const storeCols: Column<(typeof storeCoverage)[number]>[] = [
    { key: 'store', header: 'Store', render: (s) => (s as { storeName?: string }).storeName ?? s.storeId },
    { key: 'scans', header: 'Distinct EANs', numeric: true, render: (s) => formatCount(s.scans) },
    { key: 'failed', header: 'Failed', numeric: true, render: (s) => formatCount(s.failed) },
    {
      key: 'cov',
      header: 'Coverage',
      numeric: true,
      render: (s) => (
        <span className={(s.coverage ?? 1) < t.coverage_target ? 'text-[var(--color-warn)]' : undefined}>
          {formatPct(s.coverage, { precision: 2 })}
        </span>
      ),
    },
  ];

  const maxReason = Math.max(...reasons.map((r) => r.count), 1);
  const maxAge = Math.max(...ageBuckets.map((b) => b.count), 1);

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Catalogue"
        question="Of what customers tried to scan, how much worked — and why did the rest fail?"
        window={mod.window}
        scope={mod.scope}
        compareLabel={mod.compareLabel}
        sources={mod.sources}
        warnings={[...mod.warnings, ...filters.warnings]}
      />

      <FilterBar
        window={mod.window}
        stores={options.stores}
        cities={options.cities}
        states={options.states}
        showPlatform
      />

      {/* §18.6 — the daily report has silently stopped generating before. */}
      {reportGeneratedToday !== true && (
        <div className="rounded border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2 text-xs">
          <span className="font-semibold text-[var(--color-warn)]">Report health</span>{' '}
          <span className="text-[var(--text-muted)]">
            — no Scan Catalog Daily Report ingested for the latest day (expected by 09:00 IST). Check
            Tatsu and the upstream GA4→BQ job.
          </span>
        </div>
      )}

      <KpiStrip metrics={mod.kpis} compareLabel={mod.compareLabel} />

      {/* §6.3 — the missing-EAN card counts every EAN observed failing; the
          reason breakdown, the aging histogram and the register below count
          only open gaps. Both are right, and the page has to say which is
          which, or the two figures read as a contradiction. */}
      <div
        data-gap-reconciliation
        className="rounded border border-[var(--color-edge)] bg-[var(--surface)] px-3 py-2 text-2xs text-[var(--text-muted)]"
      >
        <span className="label mr-2 text-[var(--text-primary)]">Missing EANs reconcile</span>
        <span className="num">{gapReconciliation.line}</span>
        <span className="ml-2">
          — the breakdowns below count the{' '}
          <span className="num">{gapReconciliation.open.toLocaleString('en-IN')}</span> open only, so
          they will not sum to the card above.
        </span>
      </div>

      {/* §16.5.2 — three different measurements that will disagree. The
          difference between them is itself the finding. */}
      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <h2 className="label mb-1">Three coverage measurements — never blended</h2>
        <p className="mb-3 text-2xs text-[var(--text-muted)]">
          Customers mostly scan things that work; an auditor scans a random shelf. The gap between
          these is not an error.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            {
              label: 'Scan-observed',
              value: mod.kpis.find((k) => k.id === 'unique_coverage')?.value ?? null,
              denom: 'Valid customer scan attempts',
              answers: 'Of what customers tried to scan, how much worked',
            },
            {
              label: 'Store-visit audited',
              value: auditedCoverage,
              denom: 'Random shelf sample by an auditor',
              answers: "Of what's on the shelf, how much is scannable",
            },
            {
              label: 'True coverage',
              value: null,
              denom: 'SAP catalogue master',
              answers: 'Of what should exist, how much does — feed not wired (§13.9)',
            },
          ].map((c) => (
            <div key={c.label} className="rounded border border-[var(--color-edge)] p-3">
              <div className="label mb-1">{c.label}</div>
              <div className="num text-xl">{c.value == null ? '—' : formatPct(c.value, { precision: 1 })}</div>
              <div className="mt-1 text-2xs text-[var(--text-muted)]">Denominator: {c.denom}</div>
              <div className="mt-0.5 text-2xs text-[var(--text-muted)]">{c.answers}</div>
            </div>
          ))}
        </div>
      </section>

      {/* §5.4b — catalogue completeness (catalogue_health). A different question
          from scan coverage: is the product record itself complete. Kept in its
          own section so the two are never read as the same number. */}
      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="label">Catalogue completeness</h2>
          {health.state !== 'live' && <StatePill state={health.state} />}
        </div>
        <p className="mb-3 text-2xs text-[var(--text-muted)]">
          Not &ldquo;did a scan resolve&rdquo; but &ldquo;is the record complete&rdquo; — attributes
          filled, image present, on platform. Source: {health.source}.
        </p>

        <KpiStrip metrics={health.kpis} />

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <figure className="rounded border border-[var(--color-edge)] p-3">
            <figcaption className="label mb-2">Completeness by pipeline</figcaption>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-2xs text-[var(--text-muted)]">
                  <th className="label py-1 text-left">Pipeline</th>
                  <th className="label py-1 text-right">Records</th>
                  <th className="label py-1 text-right">Complete</th>
                  <th className="label py-1 text-right">Media</th>
                </tr>
              </thead>
              <tbody>
                {health.pipelines.map((p) => (
                  <tr key={p.pipeline} className="border-t border-[var(--color-edge)]">
                    <td className="py-1">{p.pipeline}</td>
                    <td className="num py-1 text-right">{formatCount(p.totalCatalog)}</td>
                    <td className="num py-1 text-right">{formatPct(p.completionPct, { precision: 1 })}</td>
                    <td className="num py-1 text-right">{formatPct(p.mediaCoveragePct, { precision: 1 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-2xs text-[var(--text-muted)]">
              SAP is the full estate master; AJIO CE is the curated, near-complete slice.
            </p>
          </figure>

          <figure className="rounded border border-[var(--color-edge)] p-3">
            <figcaption className="label mb-2">Worst-filled attributes (overall)</figcaption>
            <ul className="space-y-2">
              {health.attributes.slice(0, 6).map((a) => (
                <li key={a.attribute} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-3">
                  <span className="truncate text-xs" title={a.attribute}>
                    {a.attribute}
                  </span>
                  <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                    <div
                      className="h-full"
                      style={{
                        width: `${Math.max(a.fillRate * 100, 1)}%`,
                        background: a.fillRate < 0.3 ? 'var(--color-alert)' : 'var(--color-ion)',
                      }}
                    />
                  </div>
                  <span className="num text-right text-xs">{formatPct(a.fillRate, { precision: 0 })}</span>
                </li>
              ))}
            </ul>
          </figure>
        </div>

        {health.quality.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-edge)] pt-3">
            <div className="label mb-2">Quality issues</div>
            <div className="flex flex-wrap gap-2">
              {health.quality
                .filter((q) => q.value > 0)
                .map((q) => (
                  <span
                    key={q.metric}
                    className="rounded border border-[var(--color-edge)] px-2 py-1 text-2xs"
                  >
                    {q.metric}: <span className="num text-[var(--color-warn)]">{formatCount(q.value)}</span>
                  </span>
                ))}
            </div>
          </div>
        )}
      </section>

      <ManhattanChart
        data={daily.map((d) => ({
          dateKey: d.dateKey,
          uniqueScans: d.uniqueScans,
          uniqueFailed: d.uniqueFailed,
          uniqueCoverage: d.uniqueCoverage,
          reportGenerated: d.reportGenerated,
          source: d.source,
        }))}
        target={t.coverage_target}
      />

      <TrendLine
        title="Coverage trend"
        subtitle={`Target ${(t.coverage_target * 100).toFixed(0)}% drawn as the dashed line`}
        sourceNote={mod.sources[0]}
        height={200}
        reference={{ value: t.coverage_target, label: 'target' }}
        series={[
          {
            id: 'cov',
            label: 'Unique coverage',
            color: 'var(--color-scan)',
            unit: 'ratio',
            points: daily.map((d) => ({
              dateKey: d.dateKey,
              value: d.reportGenerated === null ? null : d.uniqueCoverage,
            })),
          },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-1">
            Gap reasons — {gapReconciliation.open.toLocaleString('en-IN')} open gaps
          </figcaption>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            Split inbound (mapping/ingestion) vs outbound (assignment/state). Config-driven taxonomy.
          </p>
          <ul className="space-y-2">
            {reasons.map((r) => (
              <li key={r.reason} className="grid grid-cols-[13rem_1fr_3.5rem] items-center gap-3">
                <span className="truncate text-xs" title={r.reason}>
                  {r.reason}
                  <span className="ml-1 text-2xs text-[var(--text-muted)]">({r.direction ?? '—'})</span>
                </span>
                <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                  <div
                    className="h-full"
                    style={{
                      width: `${(r.count / maxReason) * 100}%`,
                      background: r.direction === 'inbound' ? 'var(--color-warn)' : 'var(--color-alert)',
                    }}
                  />
                </div>
                <span className="num text-right text-xs">{formatCount(r.count)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-2xs text-[var(--text-muted)]">
            Source: fact_catalogue_gap × dim_product (bq-catalogue-master) · reason is a hypothesis
            from the catalogue-master join, confirmed by a human in the register&rsquo;s status field
          </p>
        </figure>

        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-1">
            Missing-EAN aging — {gapReconciliation.open.toLocaleString('en-IN')} open gaps
          </figcaption>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            A miss that is 30 days old is an ownership failure, not a data issue.
          </p>
          <ul className="space-y-2">
            {ageBuckets.map((b) => (
              <li key={b.bucket} className="grid grid-cols-[5rem_1fr_4rem] items-center gap-3">
                <span className="num text-xs text-[var(--text-muted)]">{b.bucket}</span>
                <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                  <div
                    className="h-full"
                    style={{
                      width: `${(b.count / maxAge) * 100}%`,
                      background: b.bucket === '30 d+' ? 'var(--color-alert)' : 'var(--color-ion)',
                    }}
                  />
                </div>
                <span className="num text-right text-xs">{formatCount(b.count)}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-[var(--color-edge)] pt-3">
            <div className="label mb-2">Store-visit audits</div>
            <ul className="space-y-1">
              {STORE_VISIT_AUDITS.map((v) => (
                <li key={v.storeLabel} className="flex justify-between gap-2 text-2xs">
                  <span className="truncate text-[var(--text-muted)]" title={v.storeLabel}>
                    {v.storeLabel}
                  </span>
                  <span className="num shrink-0">
                    {v.itemsFailed}/{v.itemsScanned} failed ={' '}
                    {formatPct((v.itemsScanned - v.itemsFailed) / v.itemsScanned, { precision: 0 })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-3 text-2xs text-[var(--text-muted)]">
            Source: fact_catalogue_gap (aging) · fact_store_visit_audit (visits) · auditor shelf
            samples are a different measurement from scan-observed coverage (§16.5.2)
          </p>
        </figure>
      </div>

      <DataTable
        caption="Store × coverage — is the gap systemic or store-specific?"
        columns={storeCols}
        rows={storeCoverage}
        rowKey={(s) => s.storeId}
        sourceNote="fact_scan_daily grouped by store_id"
        maxHeight={320}
        truncation={{
          limit: 60,
          sortKey: 'coverage, worst first',
          noun: 'stores',
          // The residual here is a floor, not a sum: the stores below the cut
          // are the *healthiest*, so what matters is that none of them is worse
          // than the last row shown.
          residual: (hidden) =>
            hidden.length === 0
              ? null
              : `all at or above ${formatPct(Math.min(...hidden.map((s) => s.coverage ?? 1)), { precision: 2 })} coverage`,
        }}
      />

      <DataTable
        caption="Missing EAN register"
        columns={gapCols}
        rows={openGaps}
        rowKey={(g) => g.ean}
        sourceNote="fact_catalogue_gap × dim_product — open gaps only (resolved and won't-fix are excluded)"
        maxHeight={520}
        truncation={{
          limit: 400,
          sortKey: 'scan volume',
          noun: 'open gaps',
          residual: (hidden) =>
            `${formatCount(hidden.reduce((a, g) => a + g.scanCount, 0))} scans behind them`,
        }}
      />
    </div>
  );
}
