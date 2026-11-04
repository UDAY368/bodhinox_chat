// Shared helpers of the /api/instagram routes (Phase 11, T2).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession, type AuthContext } from '@/lib/auth/session';
import type { InstagramActor } from '@/lib/instagram/connection';
import { InstagramError } from '@/lib/instagram/errors';
import { instagramRouteError, NO_STORE } from '@/lib/instagram/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export { NO_STORE };

export const actorOf = (session: AuthContext): InstagramActor =>
  ({ accountId: session.accountId, userId: session.userId, role: session.role });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/**
 * A mutation by a workspace admin: live session, Origin + CSRF proof, admin
 * role, then a per-user rate limit (bucket names the action).
 */
export async function adminMutation(request: Request, bucket: string,
  limit: { limit: number; windowMs: number } = RATE_LIMITS.adminAction): Promise<AuthContext | NextResponse> {
  const session = await requireSession(request);
  await assertMutation(request, session);
  if (!hasMinRole(session.role, 'admin')) throw new InstagramError('forbidden');
  const result = checkRateLimit(`instagram:${bucket}:${session.userId}`, limit);
  if (!result.success) return rateLimitResponse(result);
  return session;
}

/** instagramRouteError, always private and uncached. */
export function routeError(error: unknown): NextResponse {
  const response = instagramRouteError(error);
  response.headers.set('Cache-Control', NO_STORE['Cache-Control']);
  return response;
}

/** Reads a JSON body; an empty body is {}; anything unparsable is null. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => null);
  if (text === null || text.length > 16_384) return null;
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The ?code= values the settings card knows (anything else is shown as a generic failure). */
export const CALLBACK_ERROR_CODES = [
  'instagram_not_enabled', 'signed_out', 'forbidden', 'denied', 'state_mismatch', 'invalid_request', 'account_in_use',
  'limit_reached', 'feature_unavailable', 'instagram_token_invalid', 'meta_error', 'save_failed',
] as const;
export type CallbackErrorCode = (typeof CALLBACK_ERROR_CODES)[number];

const Keywords = z.array(z.string().max(200)).max(50);
const ReplyText = z.string().min(1).max(4000);
const MediaId = z.string().trim().regex(/^\d{1,32}$/).nullable();

/** POST body of a comment rule (normalised and byte-checked again by the service). */
export const CommentRuleCreate = z.object({
  media_id: MediaId.optional(),
  keywords: Keywords.optional(),
  reply_text: ReplyText,
  active: z.boolean().optional(),
}).strict();

/** PATCH body: any subset, at least one field. */
export const CommentRulePatch = z.object({
  media_id: MediaId.optional(),
  keywords: Keywords.optional(),
  reply_text: ReplyText.optional(),
  active: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
