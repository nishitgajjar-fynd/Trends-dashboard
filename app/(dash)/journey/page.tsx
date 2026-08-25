/** §4.3 — Journey & Funnel. */
import Link from 'next/link';
import { journeyModule } from '@/lib/services/modules';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { DropoffRanking, FunnelChart } from '@/components/charts/FunnelChart';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { FilterBar } from '@/components/filters/FilterBar';
import { getFilterOptions } from '@/lib/services/filter-options';
import { formatCount, formatPct } from '@/lib/format/currency';
import { parseFilters, type RawParams } from '@/lib/params/filters';

export const dynamic = 'force-dynamic';

export default async function JourneyPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const filters = parseFilters(await searchParams, 28);
  const [mod, options] = await Promise.all([
    journeyModule(filters),
    getFilterOptions(),
  ]);
  const { steps, dropoff, byPlatform, instrumentationGaps } = mod.data;

  const platformCols: Column<(typeof byPlatform)[number]>[] = [
    { key: 'p', header: 'Platform', render: (r) => r.platform },
    { key: 's', header: 'Sessions', numeric: true, render: (r) => formatCount(r.sessions) },
    { key: 'pu', header: 'Purchases', numeric: true, render: (r) => formatCount(r.purchases) },
    { key: 'c', header: 'Conversion', numeric: true, render: (r) => formatPct(r.conversion, { precision: 2 }) },
  ];

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Journey"
        question="Where does the journey from open → scan → bag → pay → de-tag break down?"
        window={mod.window}
        scope={mod.scope}
        compareLabel={mod.compareLabel}
        sources={mod.sources}
        warnings={[...mod.warnings, ...filters.warnings]}
      />

      {/* §16.7 — platform is a first-class filter here: iOS and Android drop
          out at different steps, and the blended funnel hides that. */}
      <FilterBar
        window={mod.window}
        stores={options.stores}
        cities={options.cities}
        states={options.states}
        showPlatform
      />

      {/* §16.4 — this page measures a funnel somebody declared. A route that is
          not in FUNNEL_STEPS cannot appear here at all, so the other reading is
          one click away rather than buried. */}
      <p className="text-2xs text-[var(--text-muted)]">
        These steps were agreed in advance. For the routes people actually took —
        found in the data, not declared —{' '}
        <Link href="/journey/discovered" className="text-[var(--color-ion)] underline">
          see Journeys found
        </Link>
        .
      </p>

      <KpiStrip metrics={mod.kpis} compareLabel={mod.compareLabel} />

      {instrumentationGaps.length > 0 && (
        <section className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 p-4">
          <h2 className="label mb-1 text-[var(--color-warn)]">Instrumentation gaps</h2>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            These render as gaps, never as zeros. Each is a sprint ticket waiting to be written
            (§5.2, §16.9).
          </p>
          <ul className="space-y-2">
            {instrumentationGaps.map((g) => (
              <li key={g.step} className="text-xs">
                <code className="num rounded bg-[var(--color-ink)] px-1">{g.step}</code>{' '}
                <span className="text-[var(--text-muted)]">— {g.note}</span>
              </li>
            ))}
          </ul>
          <Link href="/journey/events" className="mt-3 inline-block text-2xs text-[var(--color-ion)] underline">
            Full event dictionary and instrumentation backlog →
          </Link>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <FunnelChart steps={steps} />
        <DropoffRanking steps={dropoff} />
      </div>

      <DataTable
        caption="Funnel by platform"
        columns={platformCols}
        rows={byPlatform}
        rowKey={(r) => r.platform}
        sourceNote={mod.sources[0]}
        maxHeight={240}
      />
    </div>
  );
}
