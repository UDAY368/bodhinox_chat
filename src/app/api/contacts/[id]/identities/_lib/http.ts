// Shared handling for the contact identity routes (Phase 11, CRM-02).
// Off until Instagram is enabled (503 before any session or database work);
// then a live session, Origin + CSRF proof, admin role, a per-member write
// limit and a strict body; fixed codes with translated messages (Api.instagram.*).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { IdentityLinkError, IDENTITY_NOTE_MAX, type IdentityLinkActor } from '@/lib/contacts/identity-link';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, instagramRouteError, NO_STORE, notEnabledResponse } from '@/lib/instagram/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export type IdentityRouteContext = { params: Promise<{ id: string }> };

// The library trims control characters and counts code points (≤200); this only bounds the raw input.
export const noteSchema = z.string().max(IDENTITY_NOTE_MAX * 4).nullable().optional();

/** Runs an admin identity mutation: off → 503, then session, CSRF, role, rate limit and body validation. */
export async function identityMutation<T extends z.ZodTypeAny>(request: Request, schema: T, kind: 'link' | 'unlink',
  run: (actor: IdentityLinkActor, body: z.infer<T>) => Promise<Record<string, unknown>>): Promise<NextResponse> {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) return instagramErrorResponse('forbidden');
    const limit = checkRateLimit(`contactIdentity:${kind}:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const result = await run({ accountId: session.accountId, userId: session.userId, role: session.role }, parsed.data);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return identityRouteError(error);
  }
}

export function identityRouteError(error: unknown): NextResponse {
  const response = error instanceof IdentityLinkError ? instagramErrorResponse(error.code) : instagramRouteError(error);
  response.headers.set('Cache-Control', NO_STORE['Cache-Control']);
  return response;
}
