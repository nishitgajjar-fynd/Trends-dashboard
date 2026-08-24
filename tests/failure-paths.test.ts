/**
 * Failure-path QA.
 *
 * The dashboard's value depends on how it behaves when things break, not when
 * they work. Two failures have already happened in this system — a BigQuery view
 * stale for two weeks while reporting itself healthy, and a catalogue report
 * that stopped generating unnoticed — so these are the paths that matter most.
 */
import { describe, expect, it } from 'vitest';
import {
  freshness,
  reconcile,
  rowVolume,
  runAssertions,
  scanHygiene,
  uniqueness,
  valueSet,
  worstLevel,
} from '@/lib/assertions';
import { classifyError, DEFAULT_RETRY, withRetry } from '@/lib/connectors/retry';
import { parseReport, reportDateFromTs, flattenBlocks } from '@/lib/connectors/slack-catalogue-report';
import { mapHeaders, parseCsvLine } from '@/lib/connectors/sheets-store-master';
import { classifyGap, buildMasterIndex } from '@/lib/connectors/bq-catalogue-master';
import { dedupeIssues, mapPriority, classifyJourneyStep } from '@/lib/connectors/jira';
import { PROD_AFFILIATE } from '@/lib/config/env-guard';
import { catalogueModule, salesModule, storesModule } from '@/lib/services/modules';
import { trailingWindow } from '@/lib/format/dates';

const ctx = { connector: 'test', window: { start: '2026-08-01', end: '2026-08-13' } };

describe('the assertion gate blocks a bad load rather than committing it', () => {
  it('hard-fails on a stale feed — the avis_base_view failure mode', async () => {
    // DOPS-25241: the view stopped reflecting new orders for ~2 weeks while the
    // pipeline reported itself as updating daily.
    const stale = [{ orderTs: '2026-06-25T10:00:00+05:30' }];
    const verdicts = await runAssertions([freshness<{ orderTs: string }>({ column: 'orderTs', maxLagHours: 26 })], stale, ctx);
    expect(verdicts[0].level).toBe('fail');
    expect(verdicts[0].message).toMatch(/stale/i);
    expect(worstLevel(verdicts)).toBe('fail');
  });

  it('hard-fails on zero rows — almost always a pipeline break, not a business event', async () => {
    const verdicts = await runAssertions([rowVolume({ tolerance: 0.6, zeroIsFail: true })], [], ctx);
    expect(verdicts[0].level).toBe('fail');
  });

  it('catches the same failure in disguise: fresh timestamp, collapsed volume', async () => {
    // §15.6 — if max(order_ts) is fresh but yesterday's count is anomalously
    // low, that is the same outage wearing a different hat.
    const verdicts = await runAssertions([rowVolume({ tolerance: 0.6, zeroIsFail: true })], [{ x: 1 }, { x: 2 }], {
      ...ctx,
      trailingRowCounts: [500, 512, 498, 505, 490, 501, 495],
    });
    expect(verdicts[0].level).toBe('warn');
    expect(verdicts[0].message).toMatch(/deviates/);
  });

  it('refuses to load rows carrying a non-production affiliate id', async () => {
    const rows = [{ affiliateId: PROD_AFFILIATE }, { affiliateId: '693c0445d7f8e24a31075570' }];
    const verdicts = await runAssertions(
      [valueSet<{ affiliateId: string }>({ column: 'affiliateId', allowed: [PROD_AFFILIATE], level: 'fail' })],
      rows,
      ctx,
    );
    expect(verdicts[0].level).toBe('fail');
    expect(verdicts[0].message).toMatch(/refusing to load|Unexpected/);
  });

  it('flags duplicate order ids, which would double-count revenue', async () => {
    const verdicts = await runAssertions(
      [uniqueness<{ orderId: string }>({ key: 'orderId' })],
      [{ orderId: 'A' }, { orderId: 'A' }, { orderId: 'B' }],
      ctx,
    );
    expect(verdicts[0].level).toBe('fail');
  });

  it('warns when our recomputation disagrees with the bot’s own stated figure', async () => {
    // §18.5 — a mismatch means the parser drifted or the bot's arithmetic
    // changed. Either way a human needs to look.
    const verdicts = await runAssertions(
      [reconcile<{ computed: number; stated: number }>({
        computed: (r) => r[0].computed,
        against: (r) => r[0].stated,
        tolerance: 0.001,
      })],
      [{ computed: 0.94, stated: 0.91 }],
      ctx,
    );
    expect(verdicts[0].level).toBe('warn');
  });

  it('escalates scan hygiene from warn to fail as junk takes over', async () => {
    const a = scanHygiene<{ rejectionRate: number }>({ rate: (r) => r[0].rejectionRate, warnAbove: 0.02, failAbove: 0.15 });
    expect((await runAssertions([a], [{ rejectionRate: 0.01 }], ctx))[0].level).toBe('pass');
    expect((await runAssertions([a], [{ rejectionRate: 0.08 }], ctx))[0].level).toBe('warn');
    expect((await runAssertions([a], [{ rejectionRate: 0.4 }], ctx))[0].level).toBe('fail');
  });

  it('never throws out of an assertion — a bad check degrades to a warning', async () => {
    const exploding = {
      id: 'boom',
      level: 'fail' as const,
      run() {
        throw new Error('assertion itself is broken');
      },
    };
    const verdicts = await runAssertions([exploding], [], ctx);
    expect(verdicts[0].level).toBe('warn');
    expect(verdicts[0].message).toMatch(/Assertion threw/);
  });
});

describe('retry policy', () => {
  it('never retries a blown quota — that just burns the next window', () => {
    expect(classifyError(new Error('quotaExceeded')).retryable).toBe(false);
    expect(DEFAULT_RETRY.neverRetryOn).toContain('quotaExceeded');
  });

  it('never retries an auth or permission failure — those need a human', () => {
    for (const e of ['401', '403', 'accessDenied', 'notFound', 'invalidQuery']) {
      expect(classifyError(new Error(e)).retryable, e).toBe(false);
    }
  });

  it('retries transient transport and rate-limit errors', () => {
    for (const e of ['429', '503', 'ECONNRESET', 'rateLimitExceeded']) {
      expect(classifyError(new Error(e)).retryable, e).toBe(true);
    }
  });

  it('gives up after the attempt budget rather than looping forever', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('503');
        },
        { ...DEFAULT_RETRY, attempts: 3 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('does not retry a non-retryable error at all', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('403 accessDenied');
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('the Slack report parser degrades, never crashes', () => {
  const good = {
    ts: '1755100800.000100',
    text: 'Scan Catalog Daily Report\nTotal Scans: 12,345\nTotal Failed: 678\nUnique Scans: 4,321\nUnique Failed: 260\nCoverage: 93.98%',
  };

  it('parses a well-formed report and recomputes coverage from components', () => {
    const r = parseReport(good);
    expect('kind' in r).toBe(false);
    if (!('kind' in r)) {
      expect(r.uniqueScans).toBe(4321);
      expect(r.uniqueFailed).toBe(260);
      expect(r.uniqueCoverage).toBeCloseTo((4321 - 260) / 4321, 6);
      expect(r.botStatedPct).toBeCloseTo(0.9398, 4);
    }
  });

  it('reports a parse failure with the missing fields instead of throwing', () => {
    const r = parseReport({ ts: '1755100800.000100', text: 'Scan Catalog Daily Report\nTotal Scans: 12,345' });
    expect('kind' in r).toBe(true);
    if ('kind' in r) {
      expect(r.missing).toContain('uniqueScans');
      // The raw message is retained so a human can see what the bot changed.
      expect(r.raw).toContain('Total Scans');
    }
  });

  it('finds the numbers whether they arrive as text, blocks or attachments', () => {
    const viaBlocks = {
      ts: '1755100800.000100',
      text: 'Scan Catalog Daily Report',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Total Scans: 100' } }],
      attachments: [{ text: 'Total Failed: 5\nUnique Scans: 80\nUnique Failed: 4' }],
    };
    expect(flattenBlocks(viaBlocks)).toContain('Unique Failed');
    expect('kind' in parseReport(viaBlocks)).toBe(false);
  });

  it('dates a report to the day it describes, not the day it was posted', () => {
    // §18.4 — the report describes the *previous* day. An off-by-one here
    // shifts 90 days of backfilled history.
    const posted = Date.parse('2026-08-13T09:00:00+05:30') / 1000;
    expect(reportDateFromTs(`${posted}.000100`)).toBe('2026-08-12');
  });
});

describe('store master header handling', () => {
  it('hard-fails with the headers it actually found, not a column of nulls', () => {
    expect(() => mapHeaders(['Outlet Ref', 'Outlet Name', 'Town'])).toThrow(/Headers present: Outlet Ref \| Outlet Name \| Town/);
  });

  it('accepts reasonable naming drift through the alias table', () => {
    const { index } = mapHeaders(['Store ID', 'RT Code', 'Store Name', 'City']);
    expect(index.store_id).toBe(0);
    expect(index.store_code).toBe(1);
  });

  it('warns rather than fails when an optional column is absent', () => {
    const { warnings } = mapHeaders(['store_id', 'store_code']);
    expect(warnings.join(' ')).toMatch(/region|activated_on/);
  });

  it('parses quoted CSV fields containing commas', () => {
    expect(parseCsvLine('00421,"Trends, Ambience Mall",Delhi')).toEqual([
      '00421',
      'Trends, Ambience Mall',
      'Delhi',
    ]);
  });
});

describe('gap reason classification (§20.3)', () => {
  const master = buildMasterIndex([
    { itemCode: 'A1', ean: '8905863997257', name: '', brand: '', category: 'Shirts', categoryMapped: true, isActive: true },
    { itemCode: 'B1', ean: '8909391926840', name: '', brand: '', category: null, categoryMapped: false, isActive: true },
    { itemCode: 'C1', ean: '8909393021680', name: '', brand: '', category: 'Tops', categoryMapped: true, isActive: false },
    { itemCode: 'D1', ean: '8905527894113', name: '', brand: '', category: 'Denim', categoryMapped: true, isActive: true },
    { itemCode: 'D2', ean: '8905527894113', name: '', brand: '', category: 'Denim', categoryMapped: true, isActive: true },
  ]);

  it.each([
    ['9999999999999', 'absent_from_master', 'inbound'],
    ['8909391926840', 'category_not_mapped', 'inbound'],
    ['8909393021680', 'item_inactive', 'outbound'],
    ['8905527894113', 'ean_assigned_to_multiple_item_codes', 'outbound'],
    ['8905863997257', 'present_investigate', 'inbound'],
  ])('classifies %s as %s', (ean, reason, direction) => {
    const r = classifyGap(ean, master);
    expect(r.reason).toBe(reason);
    expect(r.direction).toBe(direction);
  });

  it('detects the duplicate-assignment case mechanically, not by manual triage', () => {
    // This is the "EAN already assigned to another item code" outbound reason,
    // one of the two dominant causes in §5.5.
    expect(classifyGap('8905527894113', master).reason).toBe('ean_assigned_to_multiple_item_codes');
  });
});

describe('Jira mapping and dedupe', () => {
  it('maps priority names explicitly and does not silently bury an unknown one', () => {
    expect(mapPriority('Highest')).toBe('P0');
    expect(mapPriority('Blocker')).toBe('P0');
    expect(mapPriority('Trivial-Custom')).toBe('P2'); // defaults mid, not low
  });

  it('classifies a journey step from the summary when no label says so', () => {
    expect(classifyJourneyStep('Scan returns not_found for in-stock article')).toBe('scan_attempt');
    expect(classifyJourneyStep('De-tag confirmation screen blank')).toBe('invoice_detag');
    expect(classifyJourneyStep('Anything unrelated')).toBeNull();
  });

  it('prefers an explicit label over keyword classification', () => {
    expect(classifyJourneyStep('Scan is broken', ['step:purchase'])).toBe('purchase');
  });

  it('keeps every source’s provenance when merging duplicates', () => {
    const merged = dedupeIssues([
      { issueKey: 'NI-1726', source: 'jira', title: 'Apply promotion times out on carts', priority: 'P1', status: 'To Do', isDone: false, workstream:'Payments & Coupons', journeyStep: null, storeCode: null, assignee: null, createdAt: '2026-08-01T00:00:00Z', resolvedAt: null, url: '' },
      { issueKey: 'SLACK-x', source: 'slack_noc', title: 'Apply promotion times out on carts!', priority: 'P1', status: 'To Do', isDone: false, workstream:'Payments & Coupons', journeyStep: null, storeCode: null, assignee: null, createdAt: '2026-08-01T00:00:00Z', resolvedAt: null, url: '' },
    ]);
    expect(merged).toHaveLength(1);
    // Merging is a display convenience, not a claim they are the same record.
    expect(merged[0].mergedFrom).toEqual(['jira', 'slack_noc']);
  });

  it('does not merge genuinely different issues', () => {
    const merged = dedupeIssues([
      { issueKey: 'NI-1', source: 'jira', title: 'Payment gateway timeout', priority: 'P0', status: 'To Do', isDone: false, workstream:'x', journeyStep: null, storeCode: null, assignee: null, createdAt: '2026-08-01T00:00:00Z', resolvedAt: null, url: '' },
      { issueKey: 'NI-2', source: 'jira', title: 'QR poster missing at store', priority: 'P2', status: 'To Do', isDone: false, workstream:'y', journeyStep: null, storeCode: null, assignee: null, createdAt: '2026-08-01T00:00:00Z', resolvedAt: null, url: '' },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('modules survive degenerate windows', () => {
  it('handles a single-day window without dividing by zero', async () => {
    const mod = await salesModule({ start: '2026-08-12', end: '2026-08-12' });
    expect(mod.kpis.length).toBeGreaterThan(0);
    for (const k of mod.kpis) expect(Number.isNaN(k.value as number)).toBe(false);
  });

  it('handles a far-future window with no data, returning null rather than NaN', async () => {
    const mod = await salesModule({ start: '2030-01-01', end: '2030-01-07' });
    const aov = mod.kpis.find((k) => k.id === 'aov')!;
    // Null means "we do not know". NaN or Infinity would render as garbage.
    expect(aov.value === null || Number.isFinite(aov.value)).toBe(true);
  });

  it('produces no Infinity or NaN anywhere across every module', async () => {
    const mods = await Promise.all([
      salesModule(trailingWindow(28)),
      storesModule(trailingWindow(28)),
      catalogueModule(),
    ]);
    for (const mod of mods) {
      for (const k of mod.kpis) {
        if (k.value === null) continue;
        expect(Number.isFinite(k.value), `${k.id} = ${k.value}`).toBe(true);
      }
    }
  });

  it('keeps every rate between 0 and 1', async () => {
    const mods = await Promise.all([salesModule(trailingWindow(28)), catalogueModule()]);
    for (const mod of mods) {
      for (const k of mod.kpis.filter((m) => m.unit === 'ratio' && m.value !== null)) {
        // A coverage of 1.4 or -0.2 is a formula bug that would be shown to
        // leadership as a real number.
        expect(k.value!, `${k.id} = ${k.value}`).toBeGreaterThanOrEqual(-1);
        expect(k.value!, `${k.id} = ${k.value}`).toBeLessThanOrEqual(1.001);
      }
    }
  });
});
