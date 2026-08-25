/**
 * §22 — Connector 8: `jira`. P1.
 *
 * Powers `/issues` and the P0 component of the App Health Score.
 *
 * A11 — the `NI` board is shared across Companion App, Scan & Go, Kiosk and the
 * Catalogue/Inventory pipeline. Filter by component or label, not just project,
 * or the P0 count inherits other products' bugs and the health score is wrong.
 * `profileDiscriminators()` finds the right filter instead of guessing it.
 */
import { config } from '@/lib/config';
import { rowVolume, uniqueness } from '@/lib/assertions';
import { fixtureIssues, type IssueRow } from '@/fixtures/business';
import { WORKSTREAMS } from '@/fixtures/baselines';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name: string; statusCategory?: { key: string } };
    priority?: { name: string };
    assignee?: { displayName: string } | null;
    created?: string;
    resolutiondate?: string | null;
    components?: Array<{ name: string }>;
    labels?: string[];
  };
}

/** §22.3 — priority names vary by project config. Map explicitly, warn on unmapped. */
const PRIORITY_MAP: Record<string, IssueRow['priority']> = {
  highest: 'P0',
  blocker: 'P0',
  p0: 'P0',
  critical: 'P0',
  high: 'P1',
  p1: 'P1',
  major: 'P1',
  medium: 'P2',
  p2: 'P2',
  normal: 'P2',
  low: 'P3',
  p3: 'P3',
  lowest: 'P3',
  minor: 'P3',
};

const unmappedPriorities = new Set<string>();

export function mapPriority(name: string | undefined): IssueRow['priority'] {
  const key = (name ?? '').trim().toLowerCase();
  const mapped = PRIORITY_MAP[key];
  if (!mapped) {
    // Bucketing an unknown priority as low would silently hide a P0.
    if (key) unmappedPriorities.add(key);
    return 'P2';
  }
  return mapped;
}

export function unmappedPriorityWarnings(): string[] {
  return [...unmappedPriorities].map((p) => `Unmapped Jira priority "${p}" — defaulted to P2`);
}

/** §22.3 — derive the journey step from labels, else classify from the summary. */
const STEP_KEYWORDS: Array<[RegExp, string]> = [
  [/\bscan|barcode|ean\b/i, 'scan_attempt'],
  [/\bcart|bag\b/i, 'view_cart'],
  [/\bcoupon|promo|promotion\b/i, 'begin_checkout'],
  [/\bpay|payment|upi|gateway\b/i, 'add_payment_info'],
  [/\binvoice|de-?tag|detag\b/i, 'invoice_detag'],
  [/\bpdp|product detail|size finder\b/i, 'view_item'],
  [/\blogin|session|geofence\b/i, 'session_start'],
];

export function classifyJourneyStep(summary: string, labels: string[] = []): string | null {
  const labelled = labels.find((l) => /^step[:_-]/i.test(l));
  if (labelled) return labelled.replace(/^step[:_-]/i, '');
  for (const [re, step] of STEP_KEYWORDS) if (re.test(summary)) return step;
  return null;
}

export class JiraConnector extends BaseConnector<JiraIssue, IssueRow> {
  readonly id = 'jira';
  readonly displayName = 'Jira — project NI';
  readonly freshnessSlaMinutes = 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P1' as const;
  readonly powers = ['/issues', 'p0_open', 'p0_age_p50', 'App Health Score (P0 component)'];
  readonly blockedBy = '§13.6 Jira API token; A11 component/label filter for Companion';

  isConfigured(): boolean {
    return Boolean(config.jiraEmail) && Boolean(config.jiraApiToken);
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64')}`;
  }

  private jql(): string {
    const parts = [`project = ${config.jiraProjectKey}`];
    // A11 — without this the count is wrong, so the absence is surfaced rather
    // than silently tolerated (see the caveat on `p0_open` in §5).
    if (config.jiraComponentFilter) {
      const comps = config.jiraComponentFilter
        .split(',')
        .map((c) => `"${c.trim()}"`)
        .join(', ');
      parts.push(`component IN (${comps})`);
    }
    // A11 — Companion is identified by labels, not a component.
    if (config.jiraLabelFilter) {
      const labels = config.jiraLabelFilter
        .split(',')
        .map((l) => `"${l.trim()}"`)
        .join(', ');
      parts.push(`labels IN (${labels})`);
    }
    return `${parts.join(' AND ')} ORDER BY priority DESC, created ASC`;
  }

  /**
   * A11 verification helper: profile which components and labels exist on the
   * board so the right discriminator can be chosen from data, not memory.
   */
  async profileDiscriminators(): Promise<{ components: string[]; labels: string[] }> {
    const issues = await this.fetchPage(0);
    const components = new Set<string>();
    const labels = new Set<string>();
    for (const i of issues) {
      (i.fields.components ?? []).forEach((c) => components.add(c.name));
      (i.fields.labels ?? []).forEach((l) => labels.add(l));
    }
    return { components: [...components].sort(), labels: [...labels].sort() };
  }

  private async fetchPage(startAt: number, nextPageToken?: string): Promise<JiraIssue[]> {
    // §22.2 — token-based pagination is the current endpoint; the legacy startAt
    // form still works on some instances. Token-first with an offset fallback.
    const body: Record<string, unknown> = {
      jql: this.jql(),
      fields: [
        'summary', 'status', 'priority', 'assignee', 'created',
        'resolutiondate', 'components', 'labels', 'issuetype', 'parent',
      ],
      maxResults: 100,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    else if (startAt) body.startAt = startAt;

    const res = await fetch(`${config.jiraBaseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string };
    const issues = json.issues ?? [];
    if (json.nextPageToken && issues.length === 100) {
      return [...issues, ...(await this.fetchPage(0, json.nextPageToken))];
    }
    return issues;
  }

  protected async extract(): Promise<JiraIssue[]> {
    return this.fetchPage(0);
  }

  protected transform(issues: JiraIssue[]): IssueRow[] {
    return issues.map((i) => {
      const components = (i.fields.components ?? []).map((c) => c.name);
      const workstream =
        components.find((c) => (WORKSTREAMS as readonly string[]).includes(c)) ??
        components[0] ??
        'Platform & Infra';
      return {
        issueKey: i.key,
        source: 'jira' as const,
        title: i.fields.summary,
        priority: mapPriority(i.fields.priority?.name),
        status: i.fields.status?.name ?? 'To Do',
        // The reliable done signal across a custom workflow (Closed, Released on
        // PROD, Rejected… all have statusCategory 'done'); a status-name match
        // would miss them and `resolutiondate` is set on only ~17% of them.
        isDone: i.fields.status?.statusCategory?.key === 'done',
        workstream,
        journeyStep: classifyJourneyStep(i.fields.summary, i.fields.labels),
        storeCode: null,
        assignee: i.fields.assignee?.displayName ?? null,
        createdAt: i.fields.created ?? new Date().toISOString(),
        resolvedAt: i.fields.resolutiondate ?? null,
        url: `${config.jiraBaseUrl}/browse/${i.key}`,
      };
    });
  }

  protected async load(rows: IssueRow[]): Promise<LoadResult> {
    const { getDb } = await import('@/lib/db/client');
    const { factIssues } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    if (!db) return { rowsIngested: 0, table: 'fact_issues' };
    await db
      .insert(factIssues)
      .values(
        rows.map((r) => ({
          issueKey: r.issueKey,
          source: r.source,
          title: r.title,
          priority: r.priority,
          status: r.status,
          isDone: r.isDone,
          workstream: r.workstream,
          journeyStep: r.journeyStep,
          storeCode: r.storeCode,
          assignee: r.assignee,
          createdAt: new Date(r.createdAt),
          resolvedAt: r.resolvedAt ? new Date(r.resolvedAt) : null,
          url: r.url,
        })),
      )
      .onConflictDoUpdate({
        target: factIssues.issueKey,
        set: {
          status: sql`excluded.status`,
          isDone: sql`excluded.is_done`,
          priority: sql`excluded.priority`,
          assignee: sql`excluded.assignee`,
          resolvedAt: sql`excluded.resolved_at`,
        },
      });
    return { rowsIngested: rows.length, table: 'fact_issues' };
  }

  protected fixture(): IssueRow[] {
    return fixtureIssues();
  }

  readonly assertions: Assertion<IssueRow>[] = [
    uniqueness<IssueRow>({ key: 'issueKey', level: 'fail' }),
    rowVolume<IssueRow>({ tolerance: 0.8, zeroIsFail: false }),
  ];
}

/**
 * §22.4 — dedupe across Jira, Slack NOC escalations and the Tasks sheet.
 * Merging is a display convenience, not a claim that they are the same record,
 * so every source's provenance stays visible on the row.
 */
export function dedupeIssues(rows: IssueRow[]): Array<IssueRow & { mergedFrom: string[] }> {
  const out: Array<IssueRow & { mergedFrom: string[] }> = [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

  for (const row of rows) {
    const match = out.find((existing) => {
      if (existing.issueKey === row.issueKey) return true;
      // A Slack message quoting a Jira key is the same issue.
      if (row.title.includes(existing.issueKey) || existing.title.includes(row.issueKey)) return true;
      if (similarity(norm(existing.title), norm(row.title)) > 0.85) return true;
      if (
        existing.storeCode &&
        existing.storeCode === row.storeCode &&
        existing.journeyStep === row.journeyStep &&
        existing.createdAt.slice(0, 10) === row.createdAt.slice(0, 10)
      )
        return true;
      return false;
    });
    if (match) match.mergedFrom.push(row.source);
    else out.push({ ...row, mergedFrom: [row.source] });
  }
  return out;
}

/** Dice coefficient on bigrams — cheap and good enough for title matching. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) ?? 0) + 1);
    }
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let hits = 0;
  for (const [g, n] of A) hits += Math.min(n, B.get(g) ?? 0);
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

export const jira = new JiraConnector();
