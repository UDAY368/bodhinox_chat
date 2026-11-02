import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant } from "@/lib/db/tenant";
import { UncertainDispatchError } from "@/lib/jobs/dispatch";
import { formSummaryText, recordFormResponse, type FormAnswers } from "@/lib/whatsapp/forms/responses";
import type { InboundFormPayload } from "@/lib/whatsapp/inbound-structured";

export interface IngestInboundInput {
  accountId: string; userId: string; contactId: string; conversationId: string;
  metaMessageId: string; contentType: string; contentText: string | null;
  mediaUrl: string | null; mediaType: string | null; interactiveReplyId: string | null;
  /** Structured location or address-form reply (messages.interactive_payload). */
  interactivePayload?: Record<string, unknown> | null;
  replyToMessageId: string | null; createdAt: Date;
  /** Meta id of the message this one replies to (a broadcast template, say). */
  contextMetaId?: string | null;
  /** A submitted WhatsApp form; stored with the message and summarised as its text. */
  formReply?: { flowToken: string | null; answers: FormAnswers };
  wasContactCreated: boolean; wasConversationCreated: boolean;
  /** The number (whatsapp_config.id) the message arrived on; replies go out from it. */
  whatsappConfigId?: string | null;
}
export interface MessageActionsPayload {
  kind: "message"; messageId: string; accountId: string; userId: string;
  contactId: string; conversationId: string; metaMessageId: string;
  contentType: string; contentText: string | null; interactiveReplyId: string | null;
  /** Absent on jobs queued before it existed. */
  contextMetaId?: string;
  /** The number the message arrived on. Absent on jobs queued before multi-number. */
  whatsappConfigId?: string;
  wasContactCreated: boolean; wasConversationCreated: boolean; isFirstInboundMessage: boolean;
}
export interface StatusActionsPayload {
  kind: "status"; messageId: string; accountId: string; conversationId: string;
  metaMessageId: string; status: string;
}
export type InboundActionsPayload = MessageActionsPayload | StatusActionsPayload;

/** Message identity, unread state and follow-up work commit together. */
export async function ingestInboundMessage(input: IngestInboundInput): Promise<{ messageId: string; inserted: boolean; isFirstInboundMessage: boolean }> {
  return withTenant({ accountId: input.accountId, userId: input.userId, role: "owner" }, async tx => {
    const conversation = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM conversations
      WHERE account_id=${input.accountId}::uuid AND id=${input.conversationId}::uuid AND contact_id=${input.contactId}::uuid FOR UPDATE`;
    if (!conversation.length) throw new Error("Inbound conversation is unavailable");
    const first = await tx.$queryRaw<{ is_first: boolean }[]>`SELECT NOT EXISTS(SELECT 1 FROM messages
      WHERE account_id=${input.accountId}::uuid AND conversation_id=${input.conversationId}::uuid AND sender_type='customer') AS is_first`;
    if (input.formReply) {
      // The response row commits with the message, so a redelivery stores neither twice.
      const recorded = await recordFormResponse(tx, { accountId: input.accountId, contactId: input.contactId,
        conversationId: input.conversationId, messageId: input.metaMessageId, ...input.formReply });
      const form: InboundFormPayload = { form_id: recorded.formId, form_name: recorded.formName, answers: input.formReply.answers,
        trusted: recorded.trusted, flow_run_id: recorded.flowRunId, node_key: recorded.nodeKey };
      input = { ...input, contentText: formSummaryText(recorded.formName, recorded.definition, input.formReply.answers),
        interactivePayload: { form } };
    }
    const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,
      content_text,media_url,media_type,message_id,status,created_at,reply_to_message_id,interactive_reply_id,interactive_payload)
      VALUES(${input.accountId}::uuid,${input.conversationId}::uuid,'customer',${input.contentType},${input.contentText},
        ${input.mediaUrl},${input.mediaType},${input.metaMessageId},'delivered',${input.createdAt},${input.replyToMessageId}::uuid,${input.interactiveReplyId},
        ${input.interactivePayload ? JSON.stringify(input.interactivePayload) : null}::jsonb)
      ON CONFLICT(conversation_id,message_id) DO NOTHING RETURNING id`;
    if (!inserted.length) {
      const existing = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM messages WHERE account_id=${input.accountId}::uuid
        AND conversation_id=${input.conversationId}::uuid AND message_id=${input.metaMessageId}`;
      if (!existing.length) throw new Error("Inbound message identity could not be resolved");
      return { messageId: existing[0].id, inserted: false, isFirstInboundMessage: false };
    }
    const payload: MessageActionsPayload = {
      kind: "message", messageId: inserted[0].id, accountId: input.accountId, userId: input.userId,
      contactId: input.contactId, conversationId: input.conversationId, metaMessageId: input.metaMessageId,
      contentType: input.contentType, contentText: input.contentText, interactiveReplyId: input.interactiveReplyId,
      ...(input.contextMetaId ? { contextMetaId: input.contextMetaId } : {}),
      ...(input.whatsappConfigId ? { whatsappConfigId: input.whatsappConfigId } : {}),
      wasContactCreated: input.wasContactCreated, wasConversationCreated: input.wasConversationCreated,
      isFirstInboundMessage: first[0].is_first,
    };
    await tx.$executeRaw`UPDATE conversations SET unread_count=COALESCE(unread_count,0)+1,
      last_message_text=${input.contentText || `[${input.contentType}]`},last_message_at=NOW(),
      status=CASE WHEN status='closed' THEN 'open' ELSE status END,updated_at=NOW()
      WHERE account_id=${input.accountId}::uuid AND id=${input.conversationId}::uuid`;
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES('inbound.actions',${input.accountId}::uuid,${JSON.stringify(payload)}::jsonb,${`inbound:${inserted[0].id}`})
      ON CONFLICT(dedupe_key) DO NOTHING`;
    return { messageId: inserted[0].id, inserted: true, isFirstInboundMessage: payload.isFirstInboundMessage };
  }, getWorkerPrisma());
}

export interface ProviderStatus {
  id: string; status: string; timestamp: string;
  errors?: Array<{ code: number; title: string; error_data?: { details?: string } }>;
}

/** A callback can beat the sender's local commit; the durable receipt must retry. */
export class StatusAwaitingPersistenceError extends Error {
  constructor() {
    super("Provider status awaits local outbound persistence");
    this.name = "StatusAwaitingPersistenceError";
  }
}

/** Predicates are evaluated on the locked current row, so reordered concurrent events cannot regress status. */
export async function applyProviderStatus(accountId: string, event: ProviderStatus): Promise<void> {
  if (!["sent", "delivered", "read", "failed"].includes(event.status)) return;
  const when = new Date(Number(event.timestamp) * 1000);
  if (!Number.isFinite(when.getTime())) throw new Error("Invalid provider status timestamp");
  const failure = event.status === "failed" ? event.errors?.[0] : undefined;
  await withTenant({ accountId, role: "owner" }, async tx => {
    const presence=await tx.$queryRaw<{exists:boolean}[]>`SELECT (
      EXISTS(SELECT 1 FROM messages WHERE account_id=${accountId}::uuid AND message_id=${event.id}) OR
      EXISTS(SELECT 1 FROM broadcast_recipients WHERE account_id=${accountId}::uuid AND whatsapp_message_id=${event.id})
    ) AS exists`;
    if(!presence[0]?.exists) throw new StatusAwaitingPersistenceError();
    const updated = await tx.$queryRaw<{ id: string; conversation_id: string }[]>`UPDATE messages SET status=${event.status},
      error_code=CASE WHEN ${event.status}='failed' THEN ${failure?.code ?? null} ELSE error_code END,
      error_title=CASE WHEN ${event.status}='failed' THEN ${failure?.title ?? null} ELSE error_title END,
      error_details=CASE WHEN ${event.status}='failed' THEN ${failure?.error_data?.details ?? null} ELSE error_details END
      WHERE account_id=${accountId}::uuid AND message_id=${event.id} AND
        ((${event.status}='failed' AND status IN ('sending','sent')) OR
        (${event.status}<>'failed' AND array_position(ARRAY['sending','sent','delivered','read'],${event.status})
          > array_position(ARRAY['sending','sent','delivered','read'],status)))
      RETURNING id,conversation_id`;
    await tx.$executeRaw`UPDATE broadcast_recipients SET status=${event.status},
      sent_at=CASE WHEN ${event.status}='sent' THEN ${when} ELSE sent_at END,
      delivered_at=CASE WHEN ${event.status}='delivered' THEN ${when} ELSE delivered_at END,
      read_at=CASE WHEN ${event.status}='read' THEN ${when} ELSE read_at END,
      error_message=CASE WHEN ${event.status}='failed' THEN ${failure ? `[${failure.code}] ${failure.title}${failure.error_data?.details ? `: ${failure.error_data.details}` : ""}` : null} ELSE error_message END
      WHERE account_id=${accountId}::uuid AND whatsapp_message_id=${event.id} AND
        ((${event.status}='failed' AND status IN ('pending','sent')) OR
        (${event.status}<>'failed' AND array_position(ARRAY['pending','sent','delivered','read','replied'],${event.status})
          > array_position(ARRAY['pending','sent','delivered','read','replied'],status)))`;
    for (const row of updated) {
      const payload: StatusActionsPayload = { kind: "status", messageId: row.id, accountId,
        conversationId: row.conversation_id, metaMessageId: event.id, status: event.status };
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
        VALUES('inbound.actions',${accountId}::uuid,${JSON.stringify(payload)}::jsonb,${`status:${row.id}:${event.status}`})
        ON CONFLICT(dedupe_key) DO NOTHING`;
    }
  }, getWorkerPrisma());
}

/** Completed results replay; interrupted stages require reconciliation before another external action. */
export async function runInboundStage<T>(accountId: string, messageId: string, stage: string, action: () => Promise<T>, assertLease: () => void = () => {}): Promise<T> {
  assertLease();
  const claim = await withTenant({ accountId, role: "owner" }, async tx => {
    const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO inbound_action_steps(account_id,message_id,stage)
      VALUES(${accountId}::uuid,${messageId}::uuid,${stage}) ON CONFLICT(account_id,message_id,stage) DO NOTHING RETURNING id`;
    if (inserted.length) return { claimed: true as const };
    const existing = await tx.$queryRaw<{ status: string; context: { result: T } }[]>`SELECT status,context FROM inbound_action_steps
      WHERE account_id=${accountId}::uuid AND message_id=${messageId}::uuid AND stage=${stage}`;
    if (existing[0]?.status === "completed") return { claimed: false as const, result: existing[0].context.result };
    throw new UncertainDispatchError();
  }, getWorkerPrisma());
  if (!claim.claimed) return claim.result;
  try {
    assertLease();
    const result = await action();
    const completed = await withTenant({ accountId, role: "owner" }, tx => tx.$executeRaw`UPDATE inbound_action_steps SET status='completed',
      context=${JSON.stringify({ result: result ?? null })}::jsonb,updated_at=NOW()
      WHERE account_id=${accountId}::uuid AND message_id=${messageId}::uuid AND stage=${stage} AND status='dispatching'`, getWorkerPrisma());
    if (completed !== 1) throw new UncertainDispatchError();
    return result;
  } catch {
    try {
      await withTenant({ accountId, role: "owner" }, tx => tx.$executeRaw`UPDATE inbound_action_steps SET status='uncertain',
        last_error='Inbound stage interrupted; reconcile before another external action',updated_at=NOW()
        WHERE account_id=${accountId}::uuid AND message_id=${messageId}::uuid AND stage=${stage} AND status='dispatching'`, getWorkerPrisma());
    } catch { /* The durable dispatching checkpoint still prevents unsafe replay. */ }
    throw new UncertainDispatchError();
  }
}
