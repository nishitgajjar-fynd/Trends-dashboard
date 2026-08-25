'use server';

import { revalidatePath } from 'next/cache';
import { canEdit, getSessionUser } from '@/lib/auth';
import { setAiGuardrails } from '@/lib/db/settings';

export interface SaveGuardrailsResult {
  ok: boolean;
  message: string;
}

/**
 * §28 — persist the operator AI guardrails from /settings. Gated to roles with
 * the `settings` capability; the write goes to `app_setting` and busts the
 * in-process cache, so the next brief/RCA/SQL generation uses the new rules with
 * no redeploy.
 */
export async function saveGuardrails(_prev: SaveGuardrailsResult, formData: FormData): Promise<SaveGuardrailsResult> {
  const user = getSessionUser();
  if (!canEdit(user.role, 'settings')) {
    return { ok: false, message: 'Your role cannot edit settings.' };
  }

  const text = String(formData.get('guardrails') ?? '').trim();
  if (!text) {
    return { ok: false, message: 'Guardrails cannot be empty — clear the box and save to reset is not supported.' };
  }
  if (text.length > 20_000) {
    return { ok: false, message: 'Guardrails are too long (max 20,000 characters).' };
  }

  const saved = await setAiGuardrails(text, user.email ?? user.role);
  if (!saved) {
    return { ok: false, message: 'No database configured — guardrails were not saved.' };
  }

  revalidatePath('/settings');
  return { ok: true, message: 'Saved — new AI generations will use these guardrails.' };
}
