/**
 * §18.8 — Connector 10: `slack-alerts`. P2.
 *
 * Production alerts (`C0B0APYNZTQ`) plus NOC/ops store escalations
 * (`C0BFJQDV05N`). Grouped by fingerprint, deduped, written to `fact_issues`
 * with `source = 'slack_noc'`. The permalink stays on every row so a person can
 * jump to the thread.
 */
import { config } from '@/lib/config';
import { rowVolume } from '@/lib/assertions';
import type { DateWindow } from '@/lib/format/dates';
import { fixtureIssues, type IssueRow } from '@/fixtures/business';
import { classifyJourneyStep } from './jira';
import {
  classifyMessage,
  issueKeyFor,
  parseSentryAlert,
  severityOf,
  titleFor,
} from './slack-parse';
import { respectRetryAfter } from './retry';
import { BaseConnector } from './base';
import type { Assertion, CostTier, LoadResult } from './types';

interface RawAlert {
  ts: string;
  channel: string;
  text: string;
  permalink: string;
  /** Slack's bot name. The message shape follows the sender, so this routes. */
  username: string;
}

/** Group by error signature or store code, so one broken thing is one row. */
export function fingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d{4,}/g, '#') // ids, timestamps, counts
    .replace(/[0-9a-f]{8,}/g, '#') // hashes
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function extractStoreCode(text: string): string | null {
  const m = text.match(/\bstore[\s:#-]*([0-9]{3,6})\b/i);
  return m ? m[1] : null;
}

export class SlackAlertsConnector extends BaseConnector<RawAlert, IssueRow> {
  readonly id = 'slack-alerts';
  readonly displayName = 'Slack — prod alerts & NOC escalations';
  readonly freshnessSlaMinutes = 60;
  readonly costTier: CostTier = 'free';
  readonly priority = 'P2' as const;
  readonly powers = ['/issues alert stream', 'store issue intake'];
  readonly blockedBy = '§13.6 Slack bot token';

  isConfigured(): boolean {
    return Boolean(config.slackBotToken) && Boolean(config.slackAlertsChannel);
  }

  private async history(channel: string, w: DateWindow): Promise<RawAlert[]> {
    const oldest = Math.floor(Date.parse(`${w.start}T00:00:00+05:30`) / 1000);
    const latest = Math.floor(Date.parse(`${w.end}T23:59:59+05:30`) / 1000);
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channel);
    url.searchParams.set('limit', '200');
    url.searchParams.set('oldest', String(oldest));
    url.searchParams.set('latest', String(latest));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.slackBotToken}` } });
    if (await respectRetryAfter(res)) return this.history(channel, w);
    if (!res.ok) throw new Error(`Slack ${res.status}`);
    const body = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: Array<{ ts: string; text?: string; username?: string; bot_profile?: { name?: string } }>;
    };
    if (!body.ok) throw new Error(`Slack API error: ${body.error}`);

    return (body.messages ?? []).map((m) => ({
      ts: m.ts,
      channel,
      text: m.text ?? '',
      // Sentry posts as an app, so the name arrives on `bot_profile` rather
      // than `username` depending on how the integration was installed.
      username: m.bot_profile?.name ?? m.username ?? '',
      permalink: `https://slack.com/archives/${channel}/p${m.ts.replace('.', '')}`,
    }));
  }

  protected async extract(w: DateWindow): Promise<RawAlert[]> {
    const channels = [config.slackAlertsChannel, config.slackNocChannel].filter(Boolean);
    const out: RawAlert[] = [];
    // §14.3 — sequential only.
    for (const c of channels) out.push(...(await this.history(c, w)));
    return out;
  }

  /**
   * Routes by message shape, because this channel carries three of them.
   *
   * The version this replaces fingerprinted every message as opaque text and
   * used its first 180 characters as a title. Against the real channel that
   * produces rows titled with Slack markup, a priority decided by grepping for
   * words ("P0", "outage") that never appear in a Sentry alert, and one fresh
   * "issue" every night whose title is the EOD roll-up table.
   *
   * Parsed against verbatim captures in `fixtures/slack-samples.ts`.
   */
  protected transform(alerts: RawAlert[]): IssueRow[] {
    const byKey = new Map<string, IssueRow>();
    let unparsed = 0;

    for (const a of alerts) {
      const kind = classifyMessage(a);

      // The nightly digest is a per-service count, not an incident. Loading it
      // would invent an issue a night. It is deliberately dropped here; the
      // per-service counts belong on /app-health, not in the issue register.
      if (kind === 'digest') continue;

      if (kind === 'sentry') {
        const parsed = parseSentryAlert(a.text);
        if (!parsed) {
          unparsed++;
          continue;
        }
        const key = issueKeyFor(parsed);
        const createdAt = new Date(Number(a.ts.split('.')[0]) * 1000).toISOString();
        const existing = byKey.get(key);
        // Same incident re-alerting is one row. Keep the newest reading of the
        // counts, and the earliest sighting as the created date.
        byKey.set(key, {
          issueKey: key,
          source: 'slack_noc' as const,
          title: titleFor(parsed),
          priority: severityOf(parsed),
          status: parsed.state === 'Resolved' ? 'Done' : 'To Do',
          isDone: parsed.state === 'Resolved',
          workstream: 'Platform & Infra',
          journeyStep: classifyJourneyStep(`${parsed.errorType} ${parsed.endpoint ?? ''} ${parsed.message}`),
          storeCode: null,
          assignee: null,
          createdAt: existing && existing.createdAt < createdAt ? existing.createdAt : createdAt,
          resolvedAt: null,
          url: a.permalink,
        });
        continue;
      }

      // A human talking, or a store escalation in the NOC channel. Only the
      // NOC channel produces rows from free text — in the alerts channel it is
      // conversation, and conversation is not an issue.
      if (a.channel === config.slackNocChannel && a.text.trim()) {
        const storeCode = extractStoreCode(a.text);
        const fp = fingerprint(a.text);
        const key = `SLACK-${fp.replace(/[^a-z0-9]/g, '').slice(0, 24)}-${a.ts.split('.')[0]}`;
        byKey.set(key, {
          issueKey: key,
          source: 'slack_noc' as const,
          title: a.text.slice(0, 180),
          priority: /p0|critical|down|outage/i.test(a.text) ? 'P0' : ('P2' as IssueRow['priority']),
          status: 'To Do',
          isDone: false,
          workstream: 'Store Ops',
          journeyStep: classifyJourneyStep(a.text),
          storeCode,
          assignee: null,
          createdAt: new Date(Number(a.ts.split('.')[0]) * 1000).toISOString(),
          resolvedAt: null,
          url: a.permalink,
        });
      }
    }

    // A parser that silently returns nothing for most messages still returns
    // rows and still looks healthy. Recorded so the assertion can see it.
    this.lastUnparsedCount = unparsed;
    this.lastSentryCount = alerts.filter((a) => classifyMessage(a) === 'sentry').length;

    return [...byKey.values()];
  }

  /** Set by `transform`, read by the parse-rate assertion below. */
  private lastUnparsedCount = 0;
  private lastSentryCount = 0;

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
          resolvedAt: null,
          url: r.url,
        })),
      )
      .onConflictDoUpdate({
        target: factIssues.issueKey,
        set: { title: sql`excluded.title`, status: sql`excluded.status`, isDone: sql`excluded.is_done` },
      });
    return { rowsIngested: rows.length, table: 'fact_issues' };
  }

  protected fixture(): IssueRow[] {
    return fixtureIssues().filter((i) => i.source === 'slack_noc');
  }

  readonly assertions: Assertion<IssueRow>[] = [
    rowVolume<IssueRow>({ tolerance: 0.9, zeroIsFail: false }),
    // §6.3 — parse rate, not row count. A parser that understands one message
    // in ten still produces rows and still looks healthy; the only thing that
    // reveals it is the ratio of messages recognised to messages seen.
    {
      id: 'sentry_parse_rate',
      level: 'warn' as const,
      run: () => {
        const seen = this.lastSentryCount;
        const failed = this.lastUnparsedCount;
        if (seen === 0) {
          return { id: 'sentry_parse_rate', level: 'pass' as const, message: 'No Sentry alerts in window' };
        }
        const rate = (seen - failed) / seen;
        if (rate < 0.9) {
          return {
            id: 'sentry_parse_rate',
            level: 'warn' as const,
            message: `Only ${(rate * 100).toFixed(0)}% of Sentry alerts parsed (${failed}/${seen} failed) — the message format has probably changed`,
            observed: Number(rate.toFixed(3)),
            expected: 0.9,
          };
        }
        return {
          id: 'sentry_parse_rate',
          level: 'pass' as const,
          message: `${seen} Sentry alerts, all parsed`,
          observed: seen,
        };
      },
    },
  ];
}

export const slackAlerts = new SlackAlertsConnector();
