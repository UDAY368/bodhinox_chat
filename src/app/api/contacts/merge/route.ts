// /api/contacts/merge (admins and owners) — src/lib/contacts/merge.ts
//   GET  ?keep_id=&merge_id=   what would move (counts only); changes nothing.
//   POST { keep_id, merge_id } merges merge_id into keep_id in one transaction; Origin + CSRF checked.
//   200 { counts }; 400 invalid_request; 401; 403 forbidden; 404 not_found (also another workspace's ids);
//   409 phone_conflict | identity_conflict | contact_busy; 429.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { mergeContacts, MergeError, previewMerge } from '@/lib/contacts/merge';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const NO_STORE = { 'Cache-Control': 'no-store' };
const schema = z.object({ keep_id: z.string().uuid(), merge_id: z.string().uuid() }).strict();
const fail = (code: string, status: number) => NextResponse.json({ error: code, code }, { status, headers: NO_STORE });

function mergeError(error: unknown) {
  if (error instanceof MergeError) return fail(error.code, error.status);
  return toErrorResponse(error);
}

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) return fail('forbidden', 403);
    const url = new URL(request.url);
    const parsed = schema.safeParse({ keep_id: url.searchParams.get('keep_id'), merge_id: url.searchParams.get('merge_id') });
    if (!parsed.success) return fail('invalid_request', 400);
    const counts = await previewMerge({ accountId: session.accountId, userId: session.userId, role: session.role },
      parsed.data.keep_id, parsed.data.merge_id);
    return NextResponse.json({ counts }, { headers: NO_STORE });
  } catch (error) {
    return mergeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) return fail('forbidden', 403);
    const limit = await checkRateLimit(`contactMerge:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail('invalid_request', 400);
    const counts = await mergeContacts({ accountId: session.accountId, userId: session.userId, role: session.role },
      parsed.data.keep_id, parsed.data.merge_id);
    return NextResponse.json({ counts }, { headers: NO_STORE });
  } catch (error) {
    return mergeError(error);
  }
}
