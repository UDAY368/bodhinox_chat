// POST /api/inbox/pause (agents and above) — pause or resume automated replies.
//   Body: { conversation_id, action: 'pause' | 'resume', minutes?: 30 | 60 | 180 | 360 | 720 | 1440 | null,
//           scope?: 'conversation' | 'contact' }
//   minutes null (or absent) pauses until someone resumes. scope 'contact' covers every
//   conversation of the conversation's contact. The conversation must be this workspace's
//   (read and written as the member, under RLS): another workspace's id is 404, like an unknown one.
//   200 { paused, until, paused_by }; 400 { error, code: 'invalid_pause' }; 404.
//   CSRF/mutation origin is enforced by src/proxy.ts.
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import {
  AutomationPauseError,
  parsePauseRequest,
  pauseActive,
  pauseAutomations,
  resumeAutomations,
} from '@/lib/inbox/automation-pause';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const headers = { 'Cache-Control': 'private, no-store' };

const invalid = () => NextResponse.json({ error: 'Invalid pause request', code: 'invalid_pause' }, { status: 400, headers });

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inboxPause:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const body = parsePauseRequest(await request.json().catch(() => null));
    if (!body) return invalid();
    const result = await withTenant(tenantOf(ctx), async (tx) => {
      // As the member, under RLS: another workspace's conversation is simply not found.
      const [conversation] = await tx.$queryRaw<{ contact_id: string | null }[]>`SELECT contact_id::text AS contact_id
        FROM conversations WHERE account_id=${ctx.accountId}::uuid AND id=${body.conversationId}::uuid`;
      if (!conversation) return null;
      const target = body.scope === 'contact' && conversation.contact_id
        ? { contactId: conversation.contact_id } : { conversationId: body.conversationId };
      if (body.action === 'pause') await pauseAutomations(ctx.accountId, { ...target, minutes: body.minutes, byUserId: ctx.userId }, tx);
      else await resumeAutomations(ctx.accountId, { ...target, byUserId: ctx.userId }, tx);
      const [row] = await tx.$queryRaw<{ bot_paused: boolean; bot_paused_until: Date | null; bot_paused_by: string | null }[]>`
        SELECT bot_paused, bot_paused_until, bot_paused_by::text AS bot_paused_by
        FROM conversations WHERE account_id=${ctx.accountId}::uuid AND id=${body.conversationId}::uuid`;
      return row ?? null;
    });
    if (!result) return NextResponse.json({ error: 'Conversation not found' }, { status: 404, headers });
    const paused = pauseActive(result);
    return NextResponse.json({
      paused,
      until: paused && result.bot_paused_until ? new Date(result.bot_paused_until).toISOString() : null,
      paused_by: paused ? result.bot_paused_by : null,
    }, { headers });
  } catch (error) {
    if (error instanceof AutomationPauseError) return invalid();
    return toErrorResponse(error);
  }
}
