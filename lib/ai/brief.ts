/**
 * §8.1 / §28 — The daily brief and RCA narration.
 *
 * §28.7, the rule that governs this file: failure means *no insight*, not a
 * wrong insight. On model error the hub falls back to the deterministic anomaly
 * list, which is correct but terse. A model outage degrades the dashboard; it
 * does not break it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/lib/config';
import { assertNoPii, type InsightContext } from './context';
import {
  DAILY_BRIEF_SYSTEM,
  extractCitedMetrics,
  extractNumbers,
  guardrailsVersion,
  PROMPT_VERSION,
  RCA_NARRATIVE_SYSTEM,
  withGuardrails,
} from './prompts';
import { getAiGuardrails } from '@/lib/db/settings';
import type { RcaHit } from './rca';

export interface Brief {
  body: string;
  citedMetrics: string[];
  model: string;
  promptVersion: string;
  /** True when the model was unavailable and this is the deterministic summary. */
  deterministic: boolean;
  warnings: string[];
}

export function isAiConfigured(): boolean {
  return Boolean(config.anthropicApiKey);
}

/**
 * The fallback brief. Deliberately mechanical: it states what the deterministic
 * layer found and nothing more, so it can never be mistaken for analysis.
 */
export function deterministicBrief(ctx: InsightContext): Brief {
  const red = ctx.connectorHealth.filter((c) => c.status === 'red');
  const flagged = ctx.anomalies;
  const parts: string[] = [];

  if (red.length > 0) {
    parts.push(
      `${red.length} connector${red.length > 1 ? 's are' : ' is'} failing (${red.map((c) => c.id).join(', ')}); treat affected metrics as unavailable rather than as business results.`,
    );
  }
  if (flagged.length === 0) {
    parts.push('No metric crossed its anomaly threshold today.');
  } else {
    for (const a of flagged.slice(0, 4)) {
      parts.push(`[${a.metricId}] ${a.magnitude}.`);
    }
  }
  if (ctx.calendar.isSalePeriod) {
    parts.push(
      `${ctx.calendar.saleName ?? 'A sale period'} is running, so period-on-period comparisons are affected.`,
    );
  }
  parts.push(
    `Look at first: ${red.length ? '/connectors, because a data pipeline failure explains metric movement before the business does' : flagged.length ? '/insights, for the flagged metrics above' : '/ — nothing needs attention'}.`,
  );

  return {
    body: parts.join(' '),
    citedMetrics: flagged.map((a) => a.metricId),
    model: 'none (deterministic fallback)',
    promptVersion: PROMPT_VERSION,
    deterministic: true,
    warnings: ['Model unavailable — showing the deterministic anomaly list only (§28.7)'],
  };
}

/** Every number in the output must appear in the context (§28.8). */
export function findFabricatedNumbers(body: string, ctx: InsightContext): number[] {
  const contextNumbers = new Set<number>();
  const walk = (node: unknown): void => {
    if (typeof node === 'number') {
      contextNumbers.add(round(node));
      contextNumbers.add(round(node * 100)); // ratios rendered as percentages
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(ctx);

  // Years and small ordinals are not claims about the data.
  return extractNumbers(body).filter((n) => {
    if (n >= 2020 && n <= 2100) return false;
    if (Number.isInteger(n) && Math.abs(n) <= 12) return false;
    return !contextNumbers.has(round(n));
  });
}

const round = (n: number) => Math.round(n * 10) / 10;

export async function generateDailyBrief(ctx: InsightContext): Promise<Brief> {
  if (!isAiConfigured()) return deterministicBrief(ctx);

  try {
    assertNoPii(ctx); // §28.7 — asserted, not trusted
    const guardrails = await getAiGuardrails();
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const res = await client.messages.create({
      model: config.aiModel,
      max_tokens: 600,
      system: withGuardrails(DAILY_BRIEF_SYSTEM, guardrails),
      messages: [{ role: 'user', content: JSON.stringify(ctx) }],
    });

    const body = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!body) return deterministicBrief(ctx);

    const warnings: string[] = [];
    const fabricated = findFabricatedNumbers(body, ctx);
    if (fabricated.length > 0) {
      // A brief containing numbers that aren't in the context is worse than no
      // brief — it would be read as fact by leadership.
      warnings.push(
        `Model output contained ${fabricated.length} number(s) absent from the context — falling back to the deterministic brief`,
      );
      const fallback = deterministicBrief(ctx);
      return { ...fallback, warnings: [...fallback.warnings, ...warnings] };
    }

    return {
      body,
      citedMetrics: extractCitedMetrics(body),
      model: config.aiModel,
      promptVersion: `${PROMPT_VERSION}+${guardrailsVersion(guardrails)}`,
      deterministic: false,
      warnings,
    };
  } catch (e) {
    const fallback = deterministicBrief(ctx);
    return {
      ...fallback,
      warnings: [...fallback.warnings, `Model call failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

/** §28.5 — the model writes the narrative; it never chooses the hypothesis. */
export async function narrateRca(hit: RcaHit): Promise<string> {
  const deterministic = `${hit.rule.hypothesis}. Supporting: ${hit.supporting
    .map((s) => `${s.label} — ${s.value}`)
    .join('; ')}. Confirm or rule out on ${hit.rule.module} using ${hit.rule.evidence.join(', ')}.`;

  if (!isAiConfigured()) return deterministic;

  try {
    const guardrails = await getAiGuardrails();
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const res = await client.messages.create({
      model: config.aiModel,
      max_tokens: 300,
      system: withGuardrails(RCA_NARRATIVE_SYSTEM, guardrails),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            hypothesis: hit.rule.hypothesis,
            matched: hit.matched,
            supporting: hit.supporting,
            evidence: hit.rule.evidence,
            module: hit.rule.module,
          }),
        },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || deterministic;
  } catch {
    return deterministic;
  }
}
