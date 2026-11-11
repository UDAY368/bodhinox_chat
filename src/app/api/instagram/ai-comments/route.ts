// /api/instagram/ai-comments — AI replies to Instagram comments (Stage 3, 3C).
//   GET ?view=pending|history -> { settings, items } — any member. Waiting drafts
//        carry their comment, read live from Meta (Bodhinox stores no comment text).
//   PUT { enabled?, auto_approve?, daily_cap? } -> { settings } — admin, Origin +
//        CSRF, rate limited. Nothing is posted in public without an admin's approval
//        unless auto_approve is on (and then only for positive comments).
// 409 ai_not_configured (no active AI setup); 503 while Instagram is off.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAiCommentSettings, listAiComments, MAX_DAILY_CAP, updateAiCommentSettings } from '@/lib/instagram/ai-comments-queue';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { actorOf, adminMutation, NO_STORE, readJson } from '../_lib/route';
import { aiCommentRouteError } from '../_lib/ai-comment-error';

export const runtime = 'nodejs';

const Body = z.object({
  enabled: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  daily_cap: z.number().int().min(1).max(MAX_DAILY_CAP).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

/** Each page load reads up to 25 comments from Meta: bound it per user. */
const READ_LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(request: Request) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const view = new URL(request.url).searchParams.get('view') ?? 'pending';
    if (view !== 'pending' && view !== 'history') return instagramErrorResponse('invalid_request');
    const limited = checkRateLimit(`instagram:aiCommentsRead:${session.userId}`, READ_LIMIT);
    if (!limited.success) return rateLimitResponse(limited);
    const actor = actorOf(session);
    const [settings, items] = await Promise.all([getAiCommentSettings(actor), listAiComments(actor, view)]);
    return NextResponse.json({ settings, items }, { headers: NO_STORE });
  } catch (error) {
    return aiCommentRouteError(error);
  }
}

export async function PUT(request: Request) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'aiCommentsSettings');
    if (session instanceof NextResponse) return session;
    const parsed = Body.safeParse(await readJson(request));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const settings = await updateAiCommentSettings(actorOf(session), {
      enabled: parsed.data.enabled, autoApprove: parsed.data.auto_approve, dailyCap: parsed.data.daily_cap,
    });
    return NextResponse.json({ settings }, { headers: NO_STORE });
  } catch (error) {
    return aiCommentRouteError(error);
  }
}
