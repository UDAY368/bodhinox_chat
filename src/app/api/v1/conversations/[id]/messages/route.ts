// ============================================================
// GET  /api/v1/conversations/{id}/messages — list a conversation's
//      messages (scope: messages:read), newest first, keyset-paginated.
// POST /api/v1/conversations/{id}/messages — send text to the conversation
//      on its own channel, WhatsApp or Instagram (scope: messages:send;
//      Stage 5, 5G). Body: { "text": "..." }. Optional Idempotency-Key
//      header: a repeated request sends once and returns the same result.
//      Instagram: 409 window_closed outside the 24-hour messaging window.
//      Response (201): { "data": { message_id, provider_message_id,
//      conversation_id, channel } }. The phone-based POST /api/v1/messages
//      is unchanged.
//
// The conversation is verified to belong to the key's account before
// any message is returned or sent — a foreign or unknown id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import { serializeMessage } from '@/lib/api/v1/conversations';
import { apiText, sendApiConversationText } from '@/lib/api/v1/conversation-send';
import { idempotencyKeyOf } from '@/lib/api/v1/start-flow';
import { manualRepliesBlocked } from '@/lib/platform/lifecycle';
import type { Message } from '@/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    // Gate on account ownership of the conversation first.
    const { data: conv } = await ctx.db
      .from('conversations')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!conv) return fail('not_found', 'Conversation not found', 404);

    let query = ctx.db
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/messages] list error:', error);
      return fail('internal', 'Failed to list messages', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((m) => serializeMessage(m as unknown as Message)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const { id } = await params;
    if (!UUID.test(id)) return fail('not_found', 'Conversation not found', 404);
    const idempotencyKey = idempotencyKeyOf(request);
    if (idempotencyKey === 'invalid') return fail('bad_request', 'Idempotency-Key must be 1-200 printable characters', 400);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const text = apiText(body?.text);
    if (!text) return fail('bad_request', "'text' is required (1-4096 characters)", 400);

    // A platform admin may block manual replies for a workspace; an API key is refused the same way.
    if (await manualRepliesBlocked({ accountId: ctx.accountId, role: 'owner' })) {
      return fail('workspace_manual_blocked', 'Sending from this workspace is paused by Bodhinox support', 403);
    }

    const outcome = await sendApiConversationText({
      db: ctx.db, accountId: ctx.accountId, keyId: ctx.keyId, conversationId: id, text, idempotencyKey,
    });
    if (!outcome.ok) return fail(outcome.code, outcome.message, outcome.status);
    return ok(outcome.sent, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
