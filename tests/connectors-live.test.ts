/**
 * §6.4 / §14.5 — connectors as a running system, not a list of classes.
 *
 * The failure these guard against is the one that actually happened:
 * `avis_base_view` stopped reflecting new orders on 25 Jun 2026 and ran for two
 * weeks before anyone noticed, *while the pipeline reported itself as updating
 * daily*. Every individual piece was fine. What was missing was the loop —
 * something that notices a connector has not run, and something that makes the
 * cards say so.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CONNECTORS, connectorStatuses, getConnector } from '@/lib/connectors/registry';
import { isDue, SNAPSHOT_CONNECTORS, tick, windowFor, WINDOW_DAYS } from '@/lib/connectors/scheduler';
import { daysBetween } from '@/lib/format/dates';

describe('§6.4 — the schedule is the SLA, not a cron expression', () => {
  it('declares a freshness SLA on every connector', () => {
    for (const c of CONNECTORS) {
      expect(c.freshnessSlaMinutes, `${c.id} SLA`).toBeGreaterThan(0);
      expect(Number.isFinite(c.freshnessSlaMinutes), `${c.id} SLA is finite`).toBe(true);
    }
  });

  it('gives every connector a re-run window at least as wide as its cadence', () => {
    // Late-arriving rows are the norm: GA4 finalises daily tables up to 48h
    // late, and an order at 23:58 IST lands in tomorrow's extract. A window
    // that only covers "since the last run" loses those rows permanently,
    // because nothing ever looks at that date again.
    for (const c of CONNECTORS) {
      const days = WINDOW_DAYS[c.id];
      expect(days, `${c.id} has no declared re-run window`).toBeDefined();
      const w = windowFor(c.id);
      expect(daysBetween(w.start, w.end) + 1).toBe(days);
      // A windowed connector's re-run range must span at least one full SLA
      // period, or a day falls between two runs and is never looked at again.
      // Snapshot connectors replace a whole dimension and have no such gap.
      if (!SNAPSHOT_CONNECTORS.has(c.id)) {
        expect(days * 24 * 60, `${c.id} re-run window is narrower than its SLA`).toBeGreaterThanOrEqual(
          c.freshnessSlaMinutes,
        );
      }
    }
  });

  it('honours an explicit window for a backfill', () => {
    expect(windowFor('bq-orders', '2026-04-01', '2026-04-30')).toEqual({
      start: '2026-04-01',
      end: '2026-04-30',
    });
  });

  it('does not schedule an unconfigured connector', async () => {
    // Not a failure — a known §13 blocker. Running it to watch it fall back to
    // fixtures burns a tick and fills the log with noise that hides real
    // failures.
    const unconfigured = CONNECTORS.filter((c) => !c.isConfigured());
    expect(unconfigured.length, 'no unconfigured connector to test against').toBeGreaterThan(0);
    for (const c of unconfigured) {
      const v = await isDue(c.id);
      expect(v.due, `${c.id} should not be due`).toBe(false);
      expect(v.reason).toBe('not_configured');
    }
  });

  it('runs an unconfigured connector anyway when a human forces it', async () => {
    // The manual button. Someone who has just pasted a credential needs to see
    // it work now, not at the next heartbeat.
    const v = await isDue(CONNECTORS[0].id, { force: true });
    expect(v.due).toBe(true);
    expect(v.reason).toBe('forced');
  });

  it('returns a not-due verdict for an unknown id instead of throwing', async () => {
    const v = await isDue('does-not-exist');
    expect(v.due).toBe(false);
  });
});

describe('§6.4 — a tick is safe to fire as often as the plan allows', () => {
  it('runs nothing when nothing is due, and reports why for each', async () => {
    const r = await tick();
    expect(r.ran).toEqual([]);
    expect(r.skipped.length).toBe(CONNECTORS.length);
    for (const s of r.skipped) {
      expect(['not_configured', 'not_due', 'already_running']).toContain(s.reason);
    }
  });

  it('stays inside its wall-clock budget rather than being killed mid-run', async () => {
    // A serverless invocation killed at its limit never writes the run log,
    // leaving a row stuck at `running` that blocks every future run.
    const r = await tick({ force: true, budgetMs: 0 });
    expect(r.ran).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.skipped.length).toBe(CONNECTORS.length);
  });

  it('restricts to the named connector when asked', async () => {
    const id = CONNECTORS[0].id;
    const r = await tick({ only: [id] });
    expect(r.skipped.every((s) => s.id === id)).toBe(true);
    expect(r.ran.every((x) => x.id === id)).toBe(true);
  });

  it('reports a per-connector duration, so a slow connector is identifiable', async () => {
    const id = CONNECTORS[0].id;
    const r = await tick({ only: [id], force: true });
    for (const run of r.ran) {
      expect(run.ms).toBeGreaterThanOrEqual(0);
      expect(run.source).toBeTruthy();
    }
  });
});

describe('§4.9 — the board reflects the scheduler, not a separate opinion', () => {
  it('reads the same SLA the scheduler does', async () => {
    const statuses = await connectorStatuses();
    for (const s of statuses) {
      expect(s.freshnessSlaMinutes).toBe(getConnector(s.id)!.freshnessSlaMinutes);
    }
  });

  it('counts down to the next due time rather than showing a fixed cron slot', async () => {
    const statuses = await connectorStatuses();
    for (const s of statuses) {
      expect(s.nextDueInMinutes).toBeGreaterThanOrEqual(0);
      expect(s.nextDueInMinutes).toBeLessThanOrEqual(s.freshnessSlaMinutes);
    }
  });

  it('shows an unconfigured connector as a known blocker, not a failure', async () => {
    const statuses = await connectorStatuses();
    for (const s of statuses.filter((x) => !x.configured)) {
      expect(s.health).toBe('grey');
      expect(s.running).toBe(false);
    }
  });

  it('has a valid heartbeat cadence for the deploy plan', async () => {
    // On a paid plan the heartbeat is a `*/N` minute schedule and must be at
    // least as tight as the tightest SLA. On the Vercel Hobby plan only a
    // once-daily cron is allowed, so sub-daily SLAs are met by manual runs /
    // the Kubernetes ETL rather than this heartbeat — that schedule is accepted
    // here as long as it is a valid daily cron.
    const { readFileSync } = await import('node:fs');
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const tickCron = vercel.crons.find((c: { path: string }) => c.path.startsWith('/api/cron/tick'));
    expect(tickCron, 'no heartbeat cron configured').toBeDefined();

    const interval = /^\*\/(\d+)/.exec(tickCron.schedule);
    if (interval) {
      const shortestSla = Math.min(...CONNECTORS.map((c) => c.freshnessSlaMinutes));
      expect(Number(interval[1])).toBeLessThanOrEqual(shortestSla);
    } else {
      // Fixed schedule (e.g. daily "0 3 * * *" on Hobby): just assert it is valid.
      expect(tickCron.schedule).toMatch(/^(\d+|\*)\s+(\d+|\*)\s+\S+\s+\S+\s+\S+$/);
    }
  });
});

/* ── the loop that was missing ───────────────────────────────────────────── */

describe('§14.5 — a stale mart never renders as live', () => {
  it('reports stale, not live, when the connector is past its SLA', async () => {
    // The `avis_base_view` shape: the table exists, the query succeeds, and the
    // rows stopped moving two weeks ago. A successful SELECT proves the table
    // is there, not that anything is still filling it.
    const { freshnessOf } = await import('@/lib/data/repository');

    const now = Date.now();
    const stale = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: new Date(now - 14 * 86_400_000).toISOString(),
      status: 'success' as const,
      error: null,
      seeded: false,
      runId: 1,
      startedAt: new Date(now - 14 * 86_400_000).toISOString(),
    }));
    expect(stale.state).toBe('stale');
    expect(stale.warnings.join(' ')).toMatch(/past its .* freshness SLA/);
    expect(stale.warnings.join(' ')).toMatch(/14 d/);
  });

  it('reports live when the connector completed inside its SLA', async () => {
    const { freshnessOf } = await import('@/lib/data/repository');
    const now = Date.now();
    const fresh = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: new Date(now - 60_000).toISOString(),
      status: 'success' as const,
      error: null,
      seeded: false,
      runId: 1,
      startedAt: new Date(now - 120_000).toISOString(),
    }));
    expect(fresh.state).toBe('live');
    expect(fresh.warnings).toEqual([]);
  });

  it('reports stale when the connector has never completed a run', async () => {
    const { freshnessOf } = await import('@/lib/data/repository');
    const never = await freshnessOf(['bq-orders'], async () => null);
    expect(never.state).toBe('stale');
    expect(never.warnings.join(' ')).toMatch(/no completed run on record/);
  });

  it('says the mart is on its last good snapshot after a failed run', async () => {
    // §6.3 — a hard assertion failure leaves the mart untouched. The rows are
    // valid; they are just not current, and the page has to say which.
    const { freshnessOf } = await import('@/lib/data/repository');
    const now = Date.now();
    const failed = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: new Date(now - 60_000).toISOString(),
      status: 'fail' as const,
      error: 'row_volume: 40% below the trailing median',
      seeded: false,
      runId: 1,
      startedAt: new Date(now - 120_000).toISOString(),
    }));
    expect(failed.state).toBe('stale');
    expect(failed.warnings.join(' ')).toMatch(/last good snapshot/);
    expect(failed.warnings.join(' ')).toMatch(/row_volume/);
  });

  it('is a no-op for a mart with no connector behind it', async () => {
    const { freshnessOf } = await import('@/lib/data/repository');
    expect(await freshnessOf([], async () => null)).toEqual({ state: 'live', warnings: [] });
  });
});

describe('§14.5 — a seeded mart is fixture data, whatever is in Postgres', () => {
  it('reports fixture, not live, when the last run was a seed', async () => {
    // Seeding puts fixture rows in a real table. The row count and the query
    // success prove nothing about provenance, so the flag on the run is the
    // only thing between a seeded mart and a page claiming to be live.
    const { freshnessOf } = await import('@/lib/data/repository');
    const r = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: new Date().toISOString(),
      status: 'success' as const,
      error: null,
      seeded: true,
    }));
    expect(r.state).toBe('fixture');
    expect(r.warnings.join(' ')).toMatch(/seeded from fixtures/);
  });

  it('lets fixture outrank stale, because "not real" matters more than "old"', async () => {
    const { freshnessOf } = await import('@/lib/data/repository');
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const r = await freshnessOf(['bq-orders'], async () => ({
      finishedAt: old,
      status: 'success' as const,
      error: null,
      seeded: true,
    }));
    // Calling a fixture "stale" implies it was ever current.
    expect(r.state).toBe('fixture');
  });
});

/* ── the load path, exercised ────────────────────────────────────────────── */

describe('§27.5 — every connector can actually load', () => {
  it('gives all but the deferred connectors a fixture to load', () => {
    // A connector with no fixture has never executed its own `load()`. The
    // first production run would then also be the first test of the idempotent
    // upsert, on real data, with nothing to compare against.
    //
    // ga4-api and amplitude are deferred by §13.8 and §24 respectively — they
    // are named here so the exemption is a decision rather than an oversight,
    // and so adding a fifteenth connector without a fixture fails this test.
    const deferred = new Set(['ga4-api', 'amplitude']);
    const w = { start: '2026-08-01', end: '2026-08-02' };

    for (const c of CONNECTORS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (c as any).fixture(w) as unknown[];
      if (deferred.has(c.id)) {
        expect(rows.length, `${c.id} is listed as deferred but now has a fixture`).toBe(0);
      } else {
        expect(rows.length, `${c.id} has no fixture, so its load path is untested`).toBeGreaterThan(0);
      }
    }
  });

  it('refuses to seed a production mart', async () => {
    // Fixture rows in a production mart cannot be told apart from real ones at
    // the row level afterwards. There is no honest way to un-mix them.
    const prev = process.env.NODE_ENV;
    try {
      vi.stubEnv('NODE_ENV', 'production');
      await expect(CONNECTORS[0].seed({ start: '2026-08-01', end: '2026-08-02' })).rejects.toThrow(
        /Refusing to seed/,
      );

      // …and the escape hatch is deliberately awkward to type, because
      // reaching for it should be a decision rather than a reflex.
      vi.stubEnv('ALLOW_FIXTURE_SEED', 'i-understand');
      await expect(CONNECTORS[0].seed({ start: '2026-08-01', end: '2026-08-02' })).resolves.toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(prev);
    }
  });

  it('runs the assertion gate over seeded rows too', async () => {
    // A fixture that cannot pass its own connector's assertions is a broken
    // fixture, and skipping the gate here would defer that discovery to the
    // first real load — the same problem seeding exists to solve.
    const w = { start: '2026-08-01', end: '2026-08-02' };
    const orders = getConnector('bq-orders')!;
    const result = await orders.seed(w);
    expect(result.assertions, 'seed ran no assertions').toBeDefined();
    expect(result.assertions!.length).toBeGreaterThan(0);
  });

  it('marks the seeded run so the serving layer can never call it live', async () => {
    const w = { start: '2026-08-01', end: '2026-08-02' };
    await getConnector('sentry')!.seed(w);
    const run = await (await import('@/lib/connectors/run-log')).lastRunFor('sentry');
    expect(run?.seeded).toBe(true);
    // …and the metadata says so in words, not just a flag.
    expect(run?.status === 'success' || run?.status === 'warn').toBe(true);
  });
});

/* ── the last mile ───────────────────────────────────────────────────────── */

describe('§13 — nothing is missing when a credential finally arrives', () => {
  it('documents every environment variable the code reads', () => {
    // A connector whose credential is documented nowhere is one nobody will
    // ever configure — it just sits grey on /connectors forever, and the
    // reason is invisible.

    const documented = new Set(
      (readFileSync('.env.example', 'utf8').match(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gm) ?? []).map((l) =>
        l.replace(/^#?\s*/, '').replace('=', ''),
      ),
    );

    // Set by the runtime or by the test harness, not by whoever deploys this.
    // The GCP/gcloud ones are populated by the environment (metadata server,
    // gcloud config, ADC path) and by Vercel — not app config to document.
    const ambient = new Set(['NODE_ENV', 'CHROMIUM_PATH', 'VERIFY_BASE_URL', 'VERIFY_OUT', 'E2E_PORT', 'E2E_BASE_URL', 'E2E_NO_SERVER', 'CI', 'CLOUDSDK_CONFIG', 'GCE_METADATA_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'VERCEL']);

    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          for (const m of readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
            used.add(m[1]);
          }
          // `config` reads them by name through a helper.
          for (const m of readFileSync(p, 'utf8').matchAll(/\benv\('([A-Z][A-Z0-9_]*)'/g)) {
            used.add(m[1]);
          }
        }
      }
    };
    for (const root of ['lib', 'app', 'scripts']) walk(root);

    const undocumented = [...used].filter((v) => !ambient.has(v) && !documented.has(v)).sort();
    expect(undocumented, 'add these to .env.example').toEqual([]);
  });

  it('names a §13 blocker for every connector that is not configured', async () => {
    // "Not configured" without "and here is what would configure it" leaves
    // someone reading the board with no next step.
    for (const c of CONNECTORS) {
      if (c.isConfigured()) continue;
      const d = c.descriptor();
      expect(d.blockedBy, `${c.id} is unconfigured but names no blocker`).toBeTruthy();
    }
  });

  it('declares what every connector powers, so the lineage cannot drift', () => {
    for (const c of CONNECTORS) {
      expect(c.descriptor().powers.length, `${c.id} declares no downstream`).toBeGreaterThan(0);
    }
  });
});

describe('§7 — every mart the serving layer reads has a connector that fills it', () => {
  it('has no table that is read but written by nothing', () => {
    // This is the test that would have caught the largest gap in the build:
    // `fact_scan_daily` and `fact_catalogue_gap` were read by /catalogue,
    // /stores, the Scan Strip and the test-EAN canary — and no connector wrote
    // either one. With a database configured, all of them would have found an
    // empty mart and silently fallen back to fixtures forever, including the
    // §18.7 coverage baseline.
    //
    // It stayed hidden because every individual piece was correct: the SQL was
    // written, the transform was written, the assertions were written, the
    // table existed. Only the wiring between them was missing, and nothing in
    // the type system or the tests looked across that seam.

    const repo = readFileSync('lib/data/repository.ts', 'utf8');
    const read = new Set(
      [...repo.matchAll(/\.from\((fact|dim)([A-Za-z]+)\)/g)].map((m) => `${m[1]}${m[2]}`),
    );

    const written = new Set<string>();
    for (const f of readdirSync('lib/connectors')) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join('lib/connectors', f), 'utf8');
      for (const m of src.matchAll(/\.insert\((fact|dim)([A-Za-z]+)\)/g)) {
        written.add(`${m[1]}${m[2]}`);
      }
    }

    expect(read.size, 'the repository parse found nothing — the regex has drifted').toBeGreaterThan(5);
    const orphans = [...read].filter((t) => !written.has(t)).sort();
    expect(orphans, 'these marts are read but no connector writes them').toEqual([]);
  });

  it('routes every mart read to the connectors that keep it current', () => {
    // The freshness rule can only report a stale mart if it knows which
    // connector owns it. A `tryLive` call with no connector ids always reads
    // `live`, which is the exact failure §14.5 exists to prevent.
    const repo = readFileSync('lib/data/repository.ts', 'utf8');

    // Every tryLive call must pass a non-empty connector list.
    const calls = repo.match(/return tryLive\(/g) ?? [];
    const lists = repo.match(/\n\s*\['[a-z0-9-]+'(?:,\s*'[a-z0-9-]+')*\],\n\s*\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(5);
    expect(lists.length, 'a tryLive call is missing its connector list').toBe(calls.length);

    // …and every id named there is a connector that actually exists.
    const known = new Set(CONNECTORS.map((c) => c.id));
    for (const m of repo.matchAll(/'([a-z0-9]+(?:-[a-z0-9]+)+)'/g)) {
      if (m[1].includes('-') && /^(bq|sheets|slack|jira|sentry|ga4|api|gcp|test|amplitude|catalogue)/.test(m[1])) {
        // Only assert on strings that look like connector ids, not table names.
        if (!m[1].includes('_')) {
          expect(known.has(m[1]), `repository names unknown connector "${m[1]}"`).toBe(true);
        }
      }
    }
  });
});
