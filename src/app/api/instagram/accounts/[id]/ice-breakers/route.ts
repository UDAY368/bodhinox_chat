// /api/instagram/accounts/{id}/ice-breakers — an Instagram account's
// conversation starters (Stage 2, 2E).
//   GET -> { starters: { instagramAccountId, managed, syncedAt, starters: [{ question, flowId, flowName, flowStatus, flowUsable }] } }
//        any member.
//   PUT { starters: [{ question, flow_id }] } (0-4) -> { starters } — admin, Origin + CSRF, rate limited.
//        Sets them on Instagram first, then stores them; an empty list removes them.
// 400 invalid_request (bad list, or a flow that is not an Instagram flow of
// this workspace); 404 not_found (also another workspace's id); 409 token,
// permission or disconnected; 429 rate limited or a concurrent save; 502
// meta_error; 503 while off.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { getConversationStarters, MAX_QUESTION_CHARS, MAX_STARTERS, setConversationStarters } from '@/lib/instagram/ice-breakers';
import { actorOf, adminMutation, isUuid, NO_STORE, readJson, routeError } from '../../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** Shape only; the service trims, counts characters and checks the flows. */
const Body = z.object({
  starters: z.array(z.object({
    question: z.string().max(MAX_QUESTION_CHARS * 4),
    flow_id: z.string().max(64),
  }).strict()).max(MAX_STARTERS),
}).strict();

export async function GET(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    return NextResponse.json({ starters: await getConversationStarters(actorOf(session), id) }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'iceBreakers');
    if (session instanceof NextResponse) return session;
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    const parsed = Body.safeParse(await readJson(request));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const starters = await setConversationStarters(actorOf(session), id,
      parsed.data.starters.map((s) => ({ question: s.question, flowId: s.flow_id })));
    return NextResponse.json({ starters }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
