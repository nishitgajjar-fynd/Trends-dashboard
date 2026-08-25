'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveGuardrails, type SaveGuardrailsResult } from '@/app/(dash)/settings/actions';

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-1.5 text-xs hover:border-[var(--color-ion)] disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save guardrails'}
    </button>
  );
}

/**
 * §28 — live editor for the AI house guardrails. The textarea is seeded with the
 * currently-active guardrails; saving persists them to the database and the next
 * AI generation picks them up with no redeploy. Read-only for roles that cannot
 * edit settings.
 */
export function GuardrailsEditor({ initial, canEdit }: { initial: string; canEdit: boolean }) {
  const [state, formAction] = useActionState<SaveGuardrailsResult, FormData>(saveGuardrails, {
    ok: false,
    message: '',
  });

  if (!canEdit) {
    return (
      <div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--color-edge)] bg-[var(--color-ink)] p-3 text-2xs text-[var(--text-muted)]">
          {initial}
        </pre>
        <p className="mt-2 text-2xs text-[var(--text-muted)]">Your role cannot edit these.</p>
      </div>
    );
  }

  return (
    <form action={formAction}>
      <textarea
        name="guardrails"
        defaultValue={initial}
        rows={16}
        spellCheck={false}
        className="w-full resize-y rounded border border-[var(--color-edge)] bg-[var(--color-ink)] p-3 font-mono text-2xs leading-relaxed focus:border-[var(--color-ion)] focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-3">
        <SaveButton />
        {state.message && (
          <span className={state.ok ? 'text-2xs text-[var(--color-scan)]' : 'text-2xs text-[var(--color-warn)]'}>
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
