import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { NoteError } from './notes';

const t = getT('Validation.notes');
export const noteHeaders = { 'Cache-Control': 'private, no-store' };
/** Per member: notes are cheap but each mention can notify up to 20 people. */
export const NOTE_WRITE_LIMIT = { limit: 30, windowMs: 60_000 };

/** A JSON object body, or null when the request is not one. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const invalidNoteRequest = () =>
  NextResponse.json({ error: t('invalidRequest'), code: 'invalid_request' }, { status: 400 });

/** NoteError and database permission refusals map to safe messages; anything else is generic. */
export function noteErrorResponse(error: unknown): NextResponse {
  if (error instanceof NoteError) return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status });
  // RLS or the note guard trigger refused the change (insufficient_privilege).
  const code = (error as { code?: string; meta?: { code?: string } } | null)?.meta?.code ?? (error as { code?: string } | null)?.code;
  if (code === '42501') return NextResponse.json({ error: t('forbidden'), code: 'forbidden' }, { status: 403 });
  return toErrorResponse(error);
}
