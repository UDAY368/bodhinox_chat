// /api/instagram/accounts/{id}/comment-rules/{ruleId} — admin.
//   PATCH { media_id?, keywords?, reply_text?, active? } -> { rule }
//   DELETE -> { ok: true } (allowed after the permission was withdrawn or the account disconnected)
// 404 not_found (also another workspace's ids); 409 instagram_permission_missing
// (PATCH); 503 while off. No Instagram call.

import { NextResponse } from 'next/server';
import { deleteCommentRule, updateCommentRule } from '@/lib/instagram/comment-rules';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { actorOf, adminMutation, CommentRulePatch, isUuid, NO_STORE, readJson, routeError } from '../../../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; ruleId: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'commentRules');
    if (session instanceof NextResponse) return session;
    const { id, ruleId } = await context.params;
    if (!isUuid(id) || !isUuid(ruleId)) return instagramErrorResponse('not_found');
    const parsed = CommentRulePatch.safeParse(await readJson(request));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const { media_id, keywords, reply_text, active } = parsed.data;
    const rule = await updateCommentRule(actorOf(session), id, ruleId,
      { mediaId: media_id, keywords, replyText: reply_text, active });
    return NextResponse.json({ rule }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'commentRules');
    if (session instanceof NextResponse) return session;
    const { id, ruleId } = await context.params;
    if (!isUuid(id) || !isUuid(ruleId)) return instagramErrorResponse('not_found');
    await deleteCommentRule(actorOf(session), id, ruleId);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
