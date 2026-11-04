// /api/instagram/accounts/{id}/comment-rules — admin.
//   GET  -> { rules }
//   POST { media_id?, keywords?, reply_text, active? } -> 201 { rule }
// Needs the plan's instagram feature, a connected account and the comments
// permission on its grant (409 instagram_permission_missing otherwise).
// 404 not_found (also another workspace's id); 503 while off. No Instagram call.

import { NextResponse } from 'next/server';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { createCommentRule, listCommentRules } from '@/lib/instagram/comment-rules';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { actorOf, adminMutation, CommentRuleCreate, isUuid, NO_STORE, readJson, routeError } from '../../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) return instagramErrorResponse('forbidden');
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    return NextResponse.json({ rules: await listCommentRules(actorOf(session), id) }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'commentRules');
    if (session instanceof NextResponse) return session;
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    const parsed = CommentRuleCreate.safeParse(await readJson(request));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const rule = await createCommentRule(actorOf(session), id, {
      mediaId: parsed.data.media_id ?? null,
      keywords: parsed.data.keywords ?? [],
      replyText: parsed.data.reply_text,
      active: parsed.data.active ?? true,
    });
    return NextResponse.json({ rule }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
