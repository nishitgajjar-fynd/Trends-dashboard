/**
 * §4.1 — Hub. Executive summary.
 *
 * One screen. It answers one question: is Companion healthy today, and if not,
 * where? Everything on it earns its place by answering that.
 */
import Link from 'next/link';
import { hubData } from '@/lib/services/hub';
import { deterministicBrief, generateDailyBrief } from '@/lib/ai/brief';
import { KpiCard } from '@/components/kpi/KpiCard';
import { cn } from '@/lib/cn';
import { FixtureBadge } from '@/components/data-state';

export const dynamic = 'force-dynamic';

const LIGHT_CLASS = {
  green: 'bg-[var(--color-scan)]',
  amber: 'bg-[var(--color-warn)]',
  red: 'bg-[var(--color-alert)]',
  grey: 'bg-[var(--color-edge)]',
} as const;

const LIGHT_BORDER = {
  green: 'border-[var(--color-scan)]/30',
  amber: 'border-[var(--color-warn)]/40',
  red: 'border-[var(--color-alert)]/50',
  grey: 'border-[var(--color-edge)]',
} as const;

export default async function HubPage() {
  const hub = await hubData();
  // §28.7 — no insight beats a wrong insight. Without a key this is the
  // deterministic summary, clearly labelled as such.
  const brief = process.env.ANTHROPIC_API_KEY
    ? await generateDailyBrief(hub.context)
    : deterministicBrief(hub.context);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-xl">Is Companion healthy today?</h1>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Companion App · Reliance Trends · production only
          </p>
          <p className="mt-0.5 text-2xs text-[var(--text-muted)]">
            Last 28 days ·{' '}
            <span className="num">
              {hub.context.window.start} → {hub.context.window.end}
            </span>{' '}
            IST · compared with the previous 28 days
          </p>
        </div>
        {hub.fixtureCount > 0 && (
          <div className="flex items-center gap-2 text-2xs text-[var(--text-muted)]">
            <FixtureBadge />
            <span className="num">
              {hub.fixtureCount} of {hub.totalCards} cards are fixture-backed — see{' '}
              <Link href="/connectors" className="text-[var(--color-ion)] underline">
                /connectors
              </Link>
            </span>
          </div>
        )}
      </div>

      {/* Six health lights, each naming its worst contributing metric. */}
      <section aria-label="Domain health">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {hub.lights.map((l) => (
            <Link
              key={l.domain}
              href={l.href}
              className={cn(
                'rounded border bg-[var(--surface)] p-3 transition-colors hover:border-[var(--color-ion)]/60',
                LIGHT_BORDER[l.light],
              )}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className={cn('inline-block h-2.5 w-2.5 rounded-full', LIGHT_CLASS[l.light])} />
                <span className="text-sm">{l.domain}</span>
              </div>
              {l.worst ? (
                <div>
                  <div className="num text-lg">{l.worst.value}</div>
                  <div className="text-2xs text-[var(--text-muted)]" title={l.worst.why}>
                    {l.worst.label}
                  </div>
                </div>
              ) : (
                <div className="text-2xs text-[var(--text-muted)]">No data</div>
              )}
            </Link>
          ))}
        </div>
      </section>

      <section aria-label="Headline metrics">
        <h2 className="label mb-2">Today vs previous period</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {hub.headline.map((m) => (
            <KpiCard key={m.id} metric={m} size="sm" compareLabel="vs previous 28d" />
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* §8.1 — the daily brief. Must cite the metrics it references. */}
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="label">AI daily brief</h2>
            <span className="text-2xs text-[var(--text-muted)]">
              {brief.deterministic ? 'deterministic — model not configured' : brief.model} ·{' '}
              <span className="num">{brief.promptVersion}</span>
            </span>
          </div>
          <p className="text-sm leading-relaxed">{brief.body}</p>
          {brief.citedMetrics.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--color-edge)] pt-2">
              <span className="text-2xs text-[var(--text-muted)]">Cites:</span>
              {brief.citedMetrics.map((id) => (
                <code key={id} className="num rounded bg-[var(--color-ink)] px-1 text-2xs">
                  {id}
                </code>
              ))}
            </div>
          )}
          {brief.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {brief.warnings.map((w) => (
                <li key={w} className="text-2xs text-[var(--color-warn)]">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* §4.1 — pulled from P0 Jira + the anomaly detector, not hand-maintained. */}
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-2">Top open risks</h2>
          {hub.topRisks.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              No connector failures, act-severity anomalies, or open P0s.
            </p>
          ) : (
            <ol className="space-y-3">
              {hub.topRisks.map((r, i) => (
                <li key={`${r.title}-${i}`}>
                  <Link href={r.href} className="group block">
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          'mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                          r.severity === 'act' ? 'bg-[var(--color-alert)]' : 'bg-[var(--color-warn)]',
                        )}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm group-hover:text-[var(--color-ion)]">{r.title}</div>
                        <div className="text-2xs text-[var(--text-muted)]">{r.detail}</div>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {hub.rca.length > 0 && (
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-2">Root-cause candidates</h2>
          <p className="mb-3 text-2xs text-[var(--text-muted)]">
            Generated by the deterministic rule engine (§28.5). Hypotheses, not conclusions — each
            renders with the numbers that triggered it.
          </p>
          <ul className="space-y-3">
            {hub.rca.slice(0, 3).map((hit) => (
              <li key={hit.rule.id} className="border-l-2 border-[var(--color-ion)]/50 pl-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm">{hit.rule.hypothesis}</span>
                  <code className="num text-2xs text-[var(--text-muted)]">{hit.rule.id}</code>
                  {hit.rule.priority === 'always_first' && (
                    <span className="rounded border border-[var(--color-warn)]/50 px-1 text-2xs text-[var(--color-warn)]">
                      checked first
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                  {hit.supporting.map((s) => (
                    <span key={s.label} className="text-2xs text-[var(--text-muted)]">
                      <span className="uppercase tracking-wider">{s.label}:</span>{' '}
                      <span className="num">{s.value}</span>
                    </span>
                  ))}
                </div>
                <Link href={hit.rule.module} className="text-2xs text-[var(--color-ion)] underline">
                  Prove or disprove on {hit.rule.module}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
