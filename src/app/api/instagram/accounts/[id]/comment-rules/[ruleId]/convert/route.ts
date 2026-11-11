// POST /api/instagram/accounts/{id}/comment-rules/{ruleId}/convert — admin,
// Origin + CSRF, rate limited (Stage 2, 2E). Creates the equivalent draft
// Instagram comment flow and turns the rule off in one transaction:
// 201 { flow_id }. No body. 404 not_found (also another workspace's ids);
// 503 while off. No Instagram call.

import { NextResponse } from 'next/server';
import { convertCommentRuleToFlow } from '@/lib/instagram/comment-rule-convert';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { actorOf, adminMutation, isUuid, NO_STORE, routeError } from '../../../../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; ruleId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'commentRules');
    if (session instanceof NextResponse) return session;
    const { id, ruleId } = await context.params;
    if (!isUuid(id) || !isUuid(ruleId)) return instagramErrorResponse('not_found');
    const { flowId } = await convertCommentRuleToFlow(actorOf(session), id, ruleId);
    return NextResponse.json({ flow_id: flowId }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
