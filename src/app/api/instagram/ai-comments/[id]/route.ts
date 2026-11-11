// /api/instagram/ai-comments/{id} — decide one AI-drafted comment reply (Stage 3, 3C).
//   POST { decision: 'approve' | 'reject', reply_text? } -> { status } — admin, Origin +
//        CSRF, rate limited. Only a pending draft can be decided, and only once: 409
//        already_decided otherwise. Approving queues the post in the same transaction;
//        reply_text (optional) replaces the draft first. 404 also for another workspace's id.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { decideAiComment } from '@/lib/instagram/ai-comments-queue';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { actorOf, adminMutation, isUuid, NO_STORE, readJson } from '../../_lib/route';
import { aiCommentRouteError } from '../../_lib/ai-comment-error';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

const Body = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), reply_text: z.string().max(4000).optional() }).strict(),
  z.object({ decision: z.literal('reject') }).strict(),
]);

export async function POST(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'aiCommentDecide');
    if (session instanceof NextResponse) return session;
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    const parsed = Body.safeParse(await readJson(request));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const status = await decideAiComment(actorOf(session), id, parsed.data.decision === 'approve'
      ? { decision: 'approve', ...(parsed.data.reply_text !== undefined ? { replyText: parsed.data.reply_text } : {}) }
      : { decision: 'reject' });
    return NextResponse.json({ status }, { headers: NO_STORE });
  } catch (error) {
    return aiCommentRouteError(error);
  }
}
