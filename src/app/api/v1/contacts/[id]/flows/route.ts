// ============================================================
// POST /api/v1/contacts/{id}/flows — start an active flow for a contact
// (Stage 5, 5G; scope: messages:send, since the flow sends messages).
//
// Body: { "flow_id": "<uuid>" }. Optional header Idempotency-Key (1-200
// printable characters): a repeated request with the same key queues once;
// the same key with another contact or flow is 409 idempotency_mismatch.
//
// The contact and the flow must be this key's workspace's (otherwise 404,
// never revealing the other workspace). The flow runs on the contact's most
// recent conversation on a channel the flow covers (409 no_conversation when
// there is none; 409 flow_not_active for a draft, paused or archived flow).
// The start is queued before the 202; the flow's own steps then apply every
// channel rule (the Instagram window is re-checked before each send, and a
// contact unsubscribed from Instagram automation gets nothing there).
//
// Response (202): { "data": { "status": "queued", "contact_id", "flow_id",
//                             "conversation_id", "channel" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { digest, idempotencyKeyOf, prepareStartFlow, queuedFingerprint, queueStartFlow } from '@/lib/api/v1/start-flow';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api.v1.instagram');

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const { id } = await params;
    const idempotencyKey = idempotencyKeyOf(request);
    if (idempotencyKey === 'invalid') return fail('bad_request', 'Idempotency-Key must be 1-200 printable characters', 400);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || typeof body.flow_id !== 'string') {
      return fail('bad_request', "'flow_id' is required", 400);
    }

    const prepared = await prepareStartFlow(ctx.db, ctx.accountId, id, body.flow_id);
    if (!prepared.ok) {
      switch (prepared.reason) {
        case 'contact_not_found': return fail('not_found', t('contactNotFound'), 404);
        case 'flow_not_found': return fail('not_found', 'Flow not found', 404);
        case 'flow_not_active': return fail('flow_not_active', t('flowNotActive'), 409);
        case 'no_conversation': return fail('no_conversation', 'The contact has no conversation on a channel this flow runs on', 409);
        default: return fail('bad_request', "'flow_id' must be a flow id", 400);
      }
    }

    const jobId = await queueStartFlow({
      accountId: ctx.accountId, keyId: ctx.keyId, idempotencyKey, contactId: id, conversationId: prepared.conversationId, flowId: body.flow_id,
    });
    // The same Idempotency-Key reused for another contact or flow is refused, never silently mapped to the first request.
    if (idempotencyKey && (await queuedFingerprint(ctx.accountId, jobId)) !== digest(`${id}:${body.flow_id}`)) {
      return fail('idempotency_mismatch', t('idempotencyMismatch'), 409);
    }

    return ok({ status: 'queued', contact_id: id, flow_id: body.flow_id, conversation_id: prepared.conversationId, channel: prepared.channel }, 202);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
