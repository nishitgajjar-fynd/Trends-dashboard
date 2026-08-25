/**
 * §16.4 / §28.5 — the model writes the sentence; the arithmetic finds the story.
 *
 * The division of labour here is the same one the anomaly and RCA layers
 * already use, and it is not a stylistic preference. `discoverJourneys()` and
 * `journeyFindings()` decide which journeys exist and which one is worst, using
 * exact session counts. This module turns the winner into English. If the API
 * key expires, every number, every ranking and every finding on the page is
 * unchanged — only the prose degrades to a sentence assembled from the same
 * facts.
 *
 * A model that could reorder the journeys would be a model that could quietly
 * bury the worst one, and nobody would be able to tell from the screen.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/lib/config';
import { formatINR } from '@/lib/format/currency';
import { JOURNEY_NARRATIVE_SYSTEM, JOURNEY_PROMPT_VERSION, withGuardrails } from './prompts';
import { extractNumbers } from './prompts';
import { isAiConfigured } from './brief';
import { getAiGuardrails } from '@/lib/db/settings';
import type { DiscoveredJourney, JourneyFinding, JourneyShift } from '@/lib/metrics/journeys';

export interface JourneyNarrative {
  journeyId: string;
  body: string;
  deterministic: boolean;
  model: string | null;
  promptVersion: string;
  warnings: string[];
}

/**
 * What the model is allowed to see. Constructed explicitly rather than by
 * passing the journey object, so a field added to `DiscoveredJourney` later
 * cannot silently start leaving the building.
 */
function payload(j: DiscoveredJourney, finding: JourneyFinding | undefined, shift: JourneyShift | undefined) {
  return {
    journey: j.label,
    entryStep: (j.steps[j.forkAt] ?? j.steps[0]).label,
    entrySessions: j.entrySessions,
    completedSessions: j.completedSessions,
    conversionPct: Number((j.conversion * 100).toFixed(1)),
    outcome: j.outcome,
    steps: j.steps.map((s) => ({
      step: s.label,
      sessions: s.sessions,
      retentionPct: s.retention == null ? null : Number((s.retention * 100).toFixed(1)),
      exited: s.exited,
      diverted: s.diverted,
      wentInsteadTo: s.divertedTo.map((d) => ({ step: d.label, sessions: d.sessions })),
    })),
    worstStep: j.worstStep ? { step: j.worstStep.label, sessionsThatLeft: j.worstStep.exited } : null,
    finding: finding ? { headline: finding.headline, detail: finding.detail } : null,
    changeVsPreviousWindow: shift
      ? {
          isNewPath: shift.isNew,
          conversionDeltaPp: shift.conversionDeltaPp == null ? null : Number(shift.conversionDeltaPp.toFixed(1)),
          movedStep: shift.movedStep
            ? { step: shift.movedStep.label, deltaPp: Number(shift.movedStep.deltaPp.toFixed(1)) }
            : null,
        }
      : null,
  };
}

/** The sentence that gets written when there is no model — assembled, not generated. */
export function deterministicNarrative(
  j: DiscoveredJourney,
  finding?: JourneyFinding,
  shift?: JourneyShift,
): string {
  const parts: string[] = [];
  // The entry step is the fork, not step 0: `entrySessions` is counted there,
  // and naming step 0 would pair the fork's count with the front door's label.
  const first = j.steps[j.forkAt] ?? j.steps[0];
  const last = j.steps[j.steps.length - 1];

  parts.push(
    `${j.entrySessions.toLocaleString('en-IN')} sessions reached ${first.label} and ${
      j.outcome === 'converts'
        ? `${j.completedSessions.toLocaleString('en-IN')} reached ${last.label}`
        : `the path ends at ${last.label} without a purchase`
    } — ${(j.conversion * 100).toFixed(1)}% end to end.`,
  );

  if (j.worstStep) {
    const step = j.steps.find((s) => s.event === j.worstStep!.event);
    const diverted = step?.divertedTo[0];
    parts.push(
      `The biggest hole is before ${j.worstStep.label}: ${j.worstStep.exited.toLocaleString('en-IN')} sessions ended there ` +
        `and did nothing further, while ${(j.worstStep.retention * 100).toFixed(1)}% carried through` +
        (diverted ? `, and ${diverted.sessions.toLocaleString('en-IN')} took ${diverted.label} instead.` : '.'),
    );
  }

  if (j.revenueAtRisk != null && j.revenueAtRisk > 0) {
    parts.push(
      `At the rate this journey's completers actually converted, that is ${formatINR(j.revenueAtRisk)} not taken.`,
    );
  }

  if (shift?.isNew) parts.push('This path did not appear in the comparison window at all.');
  else if (shift?.movedStep && Math.abs(shift.movedStep.deltaPp) >= 5) {
    parts.push(
      `${shift.movedStep.label} moved ${shift.movedStep.deltaPp > 0 ? 'up' : 'down'} ${Math.abs(
        shift.movedStep.deltaPp,
      ).toFixed(1)} percentage points against the comparison window.`,
    );
  }

  if (finding && parts.length === 1) parts.push(finding.detail);
  return parts.join(' ');
}

/**
 * Every number in the payload, so a fabricated one can be caught.
 *
 * Same guard as the daily brief: a narrative containing a figure that is not in
 * the input is worse than no narrative, because it reads as measurement.
 */
function allowedNumbers(p: ReturnType<typeof payload>): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === 'number') {
      out.add(Math.round(v * 10) / 10);
      out.add(Math.round(v));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(p);
  return out;
}

export async function narrateJourney(
  j: DiscoveredJourney,
  finding?: JourneyFinding,
  shift?: JourneyShift,
): Promise<JourneyNarrative> {
  const fallback = (warnings: string[] = []): JourneyNarrative => ({
    journeyId: j.id,
    body: deterministicNarrative(j, finding, shift),
    deterministic: true,
    model: null,
    promptVersion: JOURNEY_PROMPT_VERSION,
    warnings,
  });

  if (!isAiConfigured()) return fallback();

  try {
    const p = payload(j, finding, shift);
    const guardrails = await getAiGuardrails();
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const res = await client.messages.create({
      model: config.aiModel,
      max_tokens: 320,
      system: withGuardrails(JOURNEY_NARRATIVE_SYSTEM, guardrails),
      messages: [{ role: 'user', content: JSON.stringify(p) }],
    });

    const body = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!body) return fallback();

    const allowed = allowedNumbers(p);
    const fabricated = extractNumbers(body).filter((n) => {
      if (Number.isInteger(n) && Math.abs(n) <= 12) return false; // step ordinals
      return !allowed.has(Math.round(n * 10) / 10) && !allowed.has(Math.round(n));
    });
    if (fabricated.length > 0) {
      return fallback([
        `Model output contained ${fabricated.length} number(s) absent from the journey — using the assembled sentence instead`,
      ]);
    }

    return {
      journeyId: j.id,
      body,
      deterministic: false,
      model: config.aiModel,
      promptVersion: JOURNEY_PROMPT_VERSION,
      warnings: [],
    };
  } catch (e) {
    return fallback([`Model call failed: ${e instanceof Error ? e.message : String(e)}`]);
  }
}

/**
 * Narrates the top few only.
 *
 * One model call per journey on a page of six is six calls on every render of a
 * `force-dynamic` route. The cap is here rather than at the call site so it
 * cannot be forgotten by the next page that uses this.
 */
export async function narrateJourneys(
  journeys: DiscoveredJourney[],
  findings: JourneyFinding[] = [],
  shifts: JourneyShift[] = [],
  limit = 3,
): Promise<JourneyNarrative[]> {
  const findingBy = new Map(findings.map((f) => [f.journeyId, f]));
  const shiftBy = new Map(shifts.map((s) => [s.id, s]));

  const narrated = await Promise.all(
    journeys
      .slice(0, limit)
      .map((j) => narrateJourney(j, findingBy.get(j.id), shiftBy.get(j.id))),
  );

  // The rest still get a sentence — assembled, never absent, so the page does
  // not have three explained journeys and three bare ones.
  const rest = journeys.slice(limit).map<JourneyNarrative>((j) => ({
    journeyId: j.id,
    body: deterministicNarrative(j, findingBy.get(j.id), shiftBy.get(j.id)),
    deterministic: true,
    model: null,
    promptVersion: JOURNEY_PROMPT_VERSION,
    warnings: [],
  }));

  return [...narrated, ...rest];
}
