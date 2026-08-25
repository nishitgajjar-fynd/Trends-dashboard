/**
 * §8.4 / §28.6 — Ask the data.
 *
 * Flow: question → schema-aware prompt (DDL + metric definitions, no data) →
 * generated SQL → guard → SQL shown to the user before execution → run
 * read-only → render with the SQL retained → log question, SQL, row count and
 * user to `ai_insight`.
 */
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/lib/config';
import { getReadonlySql } from '@/lib/db/client';
import { guardSql, schemaPrompt, SQL_GUARD } from '@/lib/ai/sql-guard';
import { ASK_THE_DATA_SYSTEM, withGuardrails } from '@/lib/ai/prompts';
import { getAiGuardrails } from '@/lib/db/settings';
import { METRICS } from '@/lib/metrics/registry';
import { getSessionUser } from '@/lib/auth';
import { rateLimit } from '@/lib/api/guards';

export const dynamic = 'force-dynamic';

/**
 * §28.6 — if a question maps to an existing metric, answer from the metric layer
 * rather than generating SQL. Two different numbers for "orders yesterday"
 * destroys trust faster than any missing feature.
 */
function matchKnownMetric(question: string): string | null {
  const q = question.toLowerCase();
  for (const m of Object.values(METRICS)) {
    if (q.includes(m.label.toLowerCase()) && /\b(yesterday|today|this week|last week)\b/.test(q)) {
      return m.id;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const user = getSessionUser();

  // §28.9 — rate-limit per user. Each request can cost a model call and a
  // database query, so a runaway client should be stopped by the server rather
  // than noticed on the bill.
  const limit = rateLimit(`ask:${user.email}`, { limit: 20, windowSeconds: 60 });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Rate limit reached. Try again in ${limit.resetInSeconds}s.` },
      { status: 429, headers: { 'Retry-After': String(limit.resetInSeconds) } },
    );
  }

  let body: { question?: string; execute?: boolean; sql?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const question = (body.question ?? '').trim();
  if (!question) return NextResponse.json({ error: 'question is required' }, { status: 400 });

  // Step 1: generate (or re-use the already-previewed SQL).
  let rawSql = body.sql ?? '';
  let answeredFromMetricLayer: string | null = null;

  if (!rawSql) {
    answeredFromMetricLayer = matchKnownMetric(question);
    if (!config.anthropicApiKey) {
      return NextResponse.json({
        question,
        sql: '',
        violations: [],
        executed: false,
        rows: [],
        rowCount: 0,
        answeredFromMetricLayer,
        error: 'ANTHROPIC_API_KEY is not configured — text-to-SQL is unavailable (§13).',
      });
    }
    try {
      const guardrails = await getAiGuardrails();
      const client = new Anthropic({ apiKey: config.anthropicApiKey });
      const res = await client.messages.create({
        model: config.aiModel,
        max_tokens: 800,
        system: withGuardrails(ASK_THE_DATA_SYSTEM, guardrails),
        messages: [
          {
            role: 'user',
            content: `${schemaPrompt()}\n\nMetric definitions:\n${Object.values(METRICS)
              .map((m) => `- ${m.id}: ${m.formula}`)
              .join('\n')}\n\nQuestion: ${question}`,
          },
        ],
      });
      rawSql = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    } catch (e) {
      return NextResponse.json({
        question,
        sql: '',
        violations: [],
        executed: false,
        rows: [],
        rowCount: 0,
        error: `Model call failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Step 2: guard. Defence in depth — the read-only role is the real boundary.
  const guard = guardSql(rawSql);

  // Step 3: the SQL is shown to the user before results, always. Execution only
  // happens on a second, explicit request.
  if (!body.execute || !guard.ok) {
    return NextResponse.json({
      question,
      sql: guard.sql,
      violations: guard.violations,
      executed: false,
      rows: [],
      rowCount: 0,
      answeredFromMetricLayer,
    });
  }

  const sql = getReadonlySql();
  if (!sql) {
    return NextResponse.json({
      question,
      sql: guard.sql,
      violations: [],
      executed: false,
      rows: [],
      rowCount: 0,
      error:
        'DATABASE_URL_READONLY is not configured. Generated SQL only runs against a genuinely read-only role (§28.6) — it is never executed on the read-write pool.',
    });
  }

  try {
    const rows = (await sql.unsafe(guard.sql)) as unknown as Record<string, unknown>[];
    await logAsk(user.email, question, guard.sql, rows.length);
    return NextResponse.json({
      question,
      sql: guard.sql,
      violations: [],
      executed: true,
      rows: rows.slice(0, guard.appliedLimit),
      rowCount: rows.length,
      answeredFromMetricLayer,
    });
  } catch (e) {
    return NextResponse.json({
      question,
      sql: guard.sql,
      violations: [],
      executed: false,
      rows: [],
      rowCount: 0,
      error: `Query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/** §27.4 — access to /api/ask is logged with the user identity. */
async function logAsk(email: string, question: string, sql: string, rowCount: number): Promise<void> {
  try {
    const { getDb } = await import('@/lib/db/client');
    const { aiInsight } = await import('@/lib/db/schema');
    const db = getDb();
    if (!db) return;
    await db.insert(aiInsight).values({
      kind: 'answer',
      scope: 'ask',
      severity: 'info',
      title: question.slice(0, 200),
      body: sql,
      citedMetrics: { rowCount, user: email, guard: SQL_GUARD.dbRole },
      model: config.aiModel,
    });
  } catch {
    // Logging must never break the answer.
  }
}
