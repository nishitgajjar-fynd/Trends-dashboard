/** §4.7 — Issues & Operations. */
import { issuesModule } from '@/lib/services/modules';
import { KpiStrip } from '@/components/kpi/KpiCard';
import { Column, DataTable, ModuleHeader } from '@/components/table/DataTable';
import { formatCount } from '@/lib/format/currency';
import { formatIST } from '@/lib/format/dates';
import { WORKSTREAMS } from '@/fixtures/baselines';
import { config } from '@/lib/config';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

export default async function IssuesPage() {
  const mod = await issuesModule();
  const { rows, byWorkstream, byJourneyStep } = mod.data;
  const open = rows.filter((i) => !i.isDone);

  const cols: Column<(typeof rows)[number]>[] = [
    {
      key: 'key',
      header: 'Key',
      render: (i) =>
        i.url ? (
          <a href={i.url} target="_blank" rel="noreferrer" className="num text-[var(--color-ion)] underline">
            {i.issueKey.length > 18 ? `${i.issueKey.slice(0, 18)}…` : i.issueKey}
          </a>
        ) : (
          <span className="num">{i.issueKey}</span>
        ),
    },
    {
      key: 'pri',
      header: 'Priority',
      render: (i) => (
        <span
          className={cn(
            i.priority === 'P0' && 'text-[var(--color-alert)]',
            i.priority === 'P1' && 'text-[var(--color-warn)]',
          )}
        >
          {i.priority}
        </span>
      ),
    },
    { key: 'title', header: 'Title', render: (i) => i.title },
    { key: 'ws', header: 'Workstream', render: (i) => i.workstream },
    { key: 'step', header: 'Journey step', render: (i) => i.journeyStep ?? '—' },
    { key: 'status', header: 'Status', render: (i) => i.status },
    {
      key: 'assignee',
      header: 'Owner',
      render: (i) => i.assignee ?? <span className="text-[var(--color-warn)]">unowned</span>,
    },
    {
      key: 'src',
      header: 'Source',
      title: 'Provenance stays visible — merging across sources is a display convenience, not a claim they are the same record',
      render: (i) => <span className="text-2xs text-[var(--text-muted)]">{i.source}</span>,
    },
    { key: 'created', header: 'Created', numeric: true, render: (i) => formatIST(i.createdAt) },
  ];

  const maxWs = Math.max(...byWorkstream.map((w) => w.open), 1);
  const maxStep = Math.max(...byJourneyStep.map((s) => s.count), 1);

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Issues"
        question="What is broken, who owns it, and which journey step generates the most pain?"
        sources={mod.sources}
        warnings={mod.warnings}
      />

      {/* A11 — the P0 count is only correct once the board is filtered. */}
      {!config.jiraComponentFilter && !config.jiraLabelFilter && (
        <div className="rounded border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2 text-xs">
          <span className="font-semibold text-[var(--color-warn)]">Unfiltered board</span>{' '}
          <span className="text-[var(--text-muted)]">
            — the <code className="num">NI</code> board is shared across Companion, Scan &amp; Go, Kiosk
            and the Catalogue pipeline. Without a component or label filter this count inherits other
            products&rsquo; bugs, and the App Health Score P0 component is wrong (A11, §22.1). Set{' '}
            <code className="num">JIRA_COMPONENT_FILTER</code> once the discriminator is confirmed.
          </span>
        </div>
      )}

      <KpiStrip metrics={mod.kpis} />

      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-3">Workstream heatmap</figcaption>
          <ul className="space-y-1.5">
            {WORKSTREAMS.map((ws) => {
              const row = byWorkstream.find((w) => w.workstream === ws);
              const openCount = row?.open ?? 0;
              return (
                <li key={ws} className="grid grid-cols-[11rem_1fr_4rem] items-center gap-3">
                  <span className="truncate text-xs" title={ws}>
                    {ws}
                  </span>
                  <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                    <div
                      className="h-full"
                      style={{
                        width: `${(openCount / maxWs) * 100}%`,
                        background: (row?.p0 ?? 0) > 0 ? 'var(--color-alert)' : 'var(--color-ion)',
                      }}
                    />
                  </div>
                  <span className="num text-right text-xs">
                    {formatCount(openCount)}
                    {(row?.p0 ?? 0) > 0 && (
                      <span className="ml-1 text-[var(--color-alert)]">·{row!.p0}</span>
                    )}
                  </span>
                </li>
              );
            })}
            {/* §0 — Loyalty column present but disabled. */}
            {/* Recessed but legible. `opacity-40` dropped this to 3.34:1 —
                a disabled row still has to be readable, and the hatch already
                carries the "off" signal without dimming the text. */}
            <li className="grid grid-cols-[11rem_1fr_4rem] items-center gap-3">
              <span className="truncate text-xs text-[var(--text-muted)]">Reliance One Loyalty</span>
              <div className="hatch h-3 rounded-sm opacity-50" />
              <span className="text-right text-2xs text-[var(--text-muted)]">off</span>
            </li>
          </ul>
        </figure>

        <figure className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <figcaption className="label mb-1">Issues mapped onto the journey</figcaption>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            Which journey step generates the most pain.
          </p>
          <ul className="space-y-1.5">
            {byJourneyStep.map((s) => (
              <li key={s.step} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3">
                <span className="num truncate text-xs">{s.step}</span>
                <div className="h-3 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                  <div className="h-full bg-[var(--color-warn)]/70" style={{ width: `${(s.count / maxStep) * 100}%` }} />
                </div>
                <span className="num text-right text-xs">{s.count}</span>
              </li>
            ))}
          </ul>
        </figure>
      </div>

      <DataTable
        caption="Open issues"
        columns={cols}
        rows={open.sort((a, b) => a.priority.localeCompare(b.priority))}
        rowKey={(i) => i.issueKey}
        sourceNote={mod.sources[0]}
        maxHeight={520}
      />
    </div>
  );
}
