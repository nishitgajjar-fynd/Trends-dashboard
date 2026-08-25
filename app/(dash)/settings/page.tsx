/** §12 — Thresholds, SLOs, alert routing, module flags. */
import { CRITICAL_ENDPOINTS, getAiGuardrails, getThresholds } from '@/lib/db/settings';
import { ModuleHeader } from '@/components/table/DataTable';
import { GuardrailsEditor } from '@/components/settings/GuardrailsEditor';
import { config } from '@/lib/config';
import { canEdit, CAN_EDIT, getSessionUser, LANDING_BY_ROLE } from '@/lib/auth';
import { formatMs, formatPct } from '@/lib/format/currency';
import { isDbConfigured } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const t = await getThresholds();
  const guardrails = await getAiGuardrails();
  const user = getSessionUser();
  const editable = CAN_EDIT[user.role];
  const canEditSettings = canEdit(user.role, 'settings');

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Settings"
        question="What thresholds, SLOs and flags is this dashboard judging against?"
        sources={['app_setting (Postgres)', 'defaults in lib/db/settings.ts']}
      >
        <p className="mt-2 max-w-3xl text-xs text-[var(--text-muted)]">
          Thresholds live in the database rather than in env, so ops can tune them without a deploy.
          {!isDbConfigured() && (
            <span className="text-[var(--color-warn)]">
              {' '}
              No database is configured, so these are the seeded defaults and edits will not persist.
            </span>
          )}
        </p>
      </ModuleHeader>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-3">Targets</h2>
          <dl className="space-y-2">
            {[
              ['Coverage target', formatPct(t.coverage_target, { precision: 0 })],
              ['Crash-free target', formatPct(t.crash_free_target, { precision: 1 })],
              ['Payment success target', formatPct(t.payment_success_target, { precision: 0 })],
              ['API error ceiling', formatPct(t.api_error_ceiling, { precision: 0 })],
              ['P0 ceiling', String(t.p0_ceiling)],
              ['Total Trends stores (denominator)', String(t.total_trends_stores)],
              ['Anomaly z threshold', String(t.anomaly_z_threshold)],
              ['Anomaly WoW threshold', formatPct(t.anomaly_wow_threshold, { precision: 0 })],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 text-sm">
                <dt className="text-[var(--text-muted)]">{k}</dt>
                <dd className="num">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-1">Latency SLOs</h2>
          <p className="mb-3 text-2xs text-[var(--color-warn)]">
            These are placeholders. Real thresholds were never established (§25, A10), so breach
            alerting stays gated behind <code className="num">slo_confirmed</code> per endpoint.
            Confirm against the RPOS APIs Quip doc and current measured baselines before treating any
            of them as a breach signal.
          </p>
          <ul className="space-y-2">
            {CRITICAL_ENDPOINTS.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm">{e.label}</div>
                  <div className="text-2xs text-[var(--text-muted)]">{e.why}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="num text-sm">{formatMs(t.slo_p95_ms[e.id])}</div>
                  <div className="text-2xs text-[var(--color-warn)]">
                    {t.slo_confirmed[e.id] ? 'confirmed' : 'placeholder'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-3">App Health Score weights</h2>
          <ul className="space-y-2">
            {Object.entries(t.health_weights).map(([k, v]) => (
              <li key={k} className="grid grid-cols-[10rem_1fr_2.5rem] items-center gap-3">
                <span className="num text-xs">{k}</span>
                <div className="h-2.5 overflow-hidden rounded-sm bg-[var(--color-ink)]">
                  <div className="h-full bg-[var(--color-ion)]/70" style={{ width: `${(v / 30) * 100}%` }} />
                </div>
                <span className="num text-right text-xs">{v}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-2xs text-[var(--text-muted)]">
            A component with no data is excluded and the weights renormalised. Zero is never
            substituted for missing.
          </p>
        </section>

        <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
          <h2 className="label mb-3">Modules &amp; roles</h2>
          <ul className="mb-4 space-y-1.5 text-sm">
            {[
              ['Loyalty (Reliance One 2.0)', config.moduleLoyalty],
              ['Amplitude', config.moduleAmplitude],
              ['True coverage (SAP + RRA)', config.moduleTrueCoverage],
            ].map(([label, on]) => (
              <li key={String(label)} className="flex justify-between gap-3">
                <span className="text-[var(--text-muted)]">{String(label)}</span>
                <span className={on ? 'text-[var(--color-scan)]' : 'text-[var(--text-muted)]'}>
                  {on ? 'on' : 'off'}
                </span>
              </li>
            ))}
          </ul>
          <div className="border-t border-[var(--color-edge)] pt-3">
            <div className="label mb-1">Your role</div>
            <p className="text-sm">
              <span className="num uppercase">{user.role}</span> — lands on{' '}
              <code className="num">{LANDING_BY_ROLE[user.role]}</code>
            </p>
            <p className="mt-1 text-2xs text-[var(--text-muted)]">
              Can edit: {editable.length ? editable.join(', ') : 'nothing'}
            </p>
          </div>
        </section>
      </div>

      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <h2 className="label mb-3">Alert routing</h2>
        <dl className="grid gap-2 md:grid-cols-3">
          {[
            ['Catalogue report', config.slackCatalogueChannel, 'Tatsu daily Scan Catalog Report'],
            ['Production alerts', config.slackAlertsChannel, 'Connector hard-failures post here immediately'],
            ['NOC / ops', config.slackNocChannel, 'Store escalations and issue intake'],
            ['Daily digest', config.slackDigestChannel || '(not set — falls back to prod alerts)', 'Brief + act-severity anomalies, each morning'],
          ].map(([label, channel, what]) => (
            <div key={String(label)} className="rounded border border-[var(--color-edge)] p-2.5">
              <dt className="text-xs">{String(label)}</dt>
              <dd className="num text-2xs text-[var(--text-muted)]">{String(channel)}</dd>
              <dd className="mt-0.5 text-2xs text-[var(--text-muted)]">{String(what)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded border border-[var(--color-edge)] bg-[var(--surface)] p-4">
        <h2 className="label mb-1">AI Insights guardrails</h2>
        <p className="mb-3 max-w-3xl text-2xs text-[var(--text-muted)]">
          House rules appended to every AI system prompt (daily brief, root-cause hints, Ask the
          data, journey narration). They <span className="text-[var(--text-primary)]">add to</span>{' '}
          the built-in safety rails — no PII, no invented numbers, read-only SQL — and can never
          switch them off. Edits apply to the next generation, no redeploy.
          {!config.anthropicApiKey && (
            <span className="text-[var(--color-warn)]">
              {' '}
              ANTHROPIC_API_KEY is not set, so AI Insights is still on the deterministic fallback —
              these guardrails take effect once the key is configured.
            </span>
          )}
        </p>
        <GuardrailsEditor initial={guardrails} canEdit={canEditSettings} />
      </section>
    </div>
  );
}
