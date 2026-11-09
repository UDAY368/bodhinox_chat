// Per-contact erasure (audit finding 39, runbook docs/runbooks/data-requests.md).
//
// An admin or owner asks to erase one contact (POST /api/contacts/{id}/erase). The
// request is audited and queued as a contact.erase job in one transaction before it
// is acknowledged. The job (worker role, every tenant table under withTenant/RLS):
//   1. deletes the contact's mirrored inbound media files (chat-media, account-<id>/inbound/)
//      and their media_objects rows; media in the workspace library is left alone;
//   2. deletes processed raw WhatsApp webhook copies (webhook_receipts) that name the
//      contact's number on one of this workspace's own phone numbers;
//   3. clears finished job payloads of this workspace that mention the contact and
//      cancels its still-pending outbound webhook deliveries about the contact;
//   4. in one transaction: blanks campaign parameters and errors, flow run variables,
//      automation step logs and pending-step context; tombstones ad leads; deletes
//      unanswered AI questions, WhatsApp form sessions and answers and its notifications;
//      deletes the contact (conversations, messages, notes, tags, identities cascade);
//      deletes the realtime outbox copies of those rows; writes an audit row (counts only).
// Orders, payments, payment links, appointments and coupon redemptions are kept as
// business and tax records with contact_id cleared. Each step is idempotent, so a
// retried job repeats safely; a contact already gone makes the job a no-op.

import { Prisma } from '@prisma/client';

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { removeMedia, storageConfigured } from '@/lib/storage/server';

export const CONTACT_ERASE_JOB = 'contact.erase';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_BUCKET = 'chat-media';
/** A number shorter than this is not matched inside raw payloads (too many false hits). */
const MIN_NUMBER_DIGITS = 6;

export class ContactErasureError extends Error {
  constructor(public readonly code: 'not_found' | 'invalid_request', public readonly status: number) {
    super(code);
    this.name = 'ContactErasureError';
  }
}

export interface ErasureActor { accountId: string; userId: string; role: 'owner' | 'admin' | 'agent' | 'viewer' }

/** Audits and queues the erasure in one transaction (app role), before the request is acknowledged. */
export async function requestContactErasure(actor: ErasureActor, contactId: string): Promise<void> {
  if (!UUID.test(contactId)) throw new ContactErasureError('invalid_request', 400);
  await withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const found = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM contacts WHERE account_id=${actor.accountId}::uuid AND id=${contactId}::uuid`;
    if (!found[0]) throw new ContactErasureError('not_found', 404);
    // No dedupe key: a repeated request queues another job, which finds the contact gone and does nothing.
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,max_attempts)
      VALUES(${CONTACT_ERASE_JOB},${actor.accountId}::uuid,${JSON.stringify({ contactId, requestedBy: actor.userId })}::jsonb,5)`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,'contact.erasure_requested',${contactId},'{}'::jsonb)`;
  });
}

/** bucket/key of a private media proxy URL (/api/media/object?bucket=..&key=..), or null. */
export function parseMediaUrl(url: string): { bucket: string; key: string } | null {
  if (!url.startsWith('/api/media/object?')) return null;
  const params = new URLSearchParams(url.slice('/api/media/object?'.length));
  const bucket = params.get('bucket'), key = params.get('key');
  return bucket && key ? { bucket, key } : null;
}

/** Only this workspace's mirrored inbound media: what the customer sent. */
export const isErasableInboundMedia = (accountId: string, ref: { bucket: string; key: string }): boolean =>
  ref.bucket === MEDIA_BUCKET && ref.key.startsWith(`account-${accountId}/inbound/`);

export type ErasureCounts = Record<string, number>;

/** The contact.erase job. Returns what was removed (counts only), or null when the contact is already gone. */
export async function runContactErasure(accountId: string, payload: Record<string, unknown>, jobId?: string): Promise<ErasureCounts | null> {
  const contactId = payload.contactId;
  const requestedBy = typeof payload.requestedBy === 'string' && UUID.test(payload.requestedBy) ? payload.requestedBy : null;
  if (!UUID.test(accountId) || typeof contactId !== 'string' || !UUID.test(contactId)) throw new Error('Invalid contact erasure job');
  const scope = { accountId, role: 'owner' as const };
  const worker = getWorkerPrisma();

  const found = await withTenant(scope, async (tx) => {
    const contact = await tx.$queryRaw<{ phone: string | null; wa: string | null }[]>`
      SELECT NULLIF(phone_normalized,'') AS phone, NULLIF(wa_user_id,'') AS wa FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
    if (!contact[0]) return null;
    const media = await tx.$queryRaw<{ media_url: string }[]>`
      SELECT DISTINCT m.media_url FROM messages m
      JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
      WHERE c.account_id=${accountId}::uuid AND c.contact_id=${contactId}::uuid AND m.media_url LIKE '/api/media/object?%'`;
    const numbers = await tx.$queryRaw<{ phone_number_id: string }[]>`
      SELECT phone_number_id FROM whatsapp_config WHERE account_id=${accountId}::uuid`;
    return { contact: contact[0], media: media.map((r) => r.media_url), phoneNumberIds: numbers.map((r) => r.phone_number_id) };
  }, worker);
  if (!found) return null;

  // 1. Media files. Library items are kept (they belong to the workspace, not the customer).
  const refs = found.media.map(parseMediaUrl).filter((r): r is { bucket: string; key: string } => !!r && isErasableInboundMedia(accountId, r));
  const library = refs.length ? await withTenant(scope, (tx) => tx.$queryRaw<{ object_key: string }[]>`
    SELECT object_key FROM media_objects WHERE account_id=${accountId}::uuid AND bucket=${MEDIA_BUCKET}
      AND object_key = ANY(${refs.map((r) => r.key)}::text[]) AND in_library`, worker) : [];
  const keep = new Set(library.map((r) => r.object_key));
  let mediaFiles = 0;
  const stored = storageConfigured();
  for (const ref of refs) {
    if (keep.has(ref.key)) continue;
    if (stored) await removeMedia(scope, ref.bucket, ref.key, true);
    else await withTenant(scope, (tx) => tx.$executeRaw`DELETE FROM media_objects
      WHERE account_id=${accountId}::uuid AND bucket=${ref.bucket} AND object_key=${ref.key}`, worker);
    mediaFiles += 1;
  }

  // 2. Raw inbound webhook copies on this workspace's numbers only (processed ones; never another tenant's).
  const ids = [found.contact.phone, found.contact.wa].filter((v): v is string => !!v && v.replace(/\D/g, '').length >= MIN_NUMBER_DIGITS);
  const webhookReceipts = ids.length && found.phoneNumberIds.length ? await worker.$executeRaw`
    DELETE FROM webhook_receipts r WHERE r.provider='meta' AND r.status='processed' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.payload->'entry')='array' THEN r.payload->'entry' ELSE '[]'::jsonb END) e,
        jsonb_array_elements(CASE WHEN jsonb_typeof(e->'changes')='array' THEN e->'changes' ELSE '[]'::jsonb END) ch
      WHERE ch->'value'->'metadata'->>'phone_number_id' = ANY(${found.phoneNumberIds}::text[])
        AND (EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ch->'value'->'contacts')='array' THEN ch->'value'->'contacts' ELSE '[]'::jsonb END) k
               WHERE k->>'wa_id' = ANY(${ids}::text[]) OR k->>'user_id' = ANY(${ids}::text[]))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ch->'value'->'messages')='array' THEN ch->'value'->'messages' ELSE '[]'::jsonb END) mm
               WHERE mm->>'from' = ANY(${ids}::text[]))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ch->'value'->'statuses')='array' THEN ch->'value'->'statuses' ELSE '[]'::jsonb END) s
               WHERE s->>'recipient_id' = ANY(${ids}::text[]))))` : 0;

  // 3. Job payloads of this workspace that mention the contact (finished: cleared; pending deliveries: cancelled).
  const needles = [contactId, ...ids].map((v) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const self = jobId && UUID.test(jobId) ? jobId : '00000000-0000-0000-0000-000000000000';
  const mentions = Prisma.sql`payload::text LIKE ANY(${needles}::text[])`;
  const jobPayloads = await worker.$executeRaw`UPDATE jobs SET payload='{}'::jsonb
    WHERE tenant_id=${accountId}::uuid AND status IN ('done','failed') AND id<>${self}::uuid AND payload<>'{}'::jsonb AND ${mentions}`;
  const pendingDeliveries = await worker.$executeRaw`DELETE FROM jobs
    WHERE tenant_id=${accountId}::uuid AND type='webhook.delivery' AND status='pending' AND ${mentions}`;

  // 4. Rows, in one transaction with the contact delete.
  const counts = await withTenant(scope, async (tx) => {
    const conversations = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM conversations WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid`;
    const where = Prisma.sql`account_id=${accountId}::uuid AND contact_id=${contactId}::uuid`;
    const c: ErasureCounts = { mediaFiles, webhookReceipts, jobPayloads: jobPayloads + pendingDeliveries };
    c.campaignRecipients = await tx.$executeRaw`UPDATE broadcast_recipients SET template_params=NULL, error_message=NULL WHERE ${where}`;
    c.flowRuns = await tx.$executeRaw`UPDATE flow_runs SET vars='{}'::jsonb WHERE ${where} AND vars<>'{}'::jsonb`;
    c.automationLogs = await tx.$executeRaw`UPDATE automation_logs SET steps_executed='[]'::jsonb, error_message=NULL WHERE ${where}`;
    c.automationSteps = await tx.$executeRaw`UPDATE automation_pending_executions SET context='{}'::jsonb WHERE ${where}`;
    c.adLeads = await tx.$executeRaw`UPDATE meta_leads SET status='erased', field_data='[]'::jsonb, contact_id=NULL, ad_name=NULL,
      campaign_name=NULL, lead_created_at=NULL, fetched_at=NULL, fetch_error_code=NULL WHERE ${where}`;
    c.aiQuestions = await tx.$executeRaw`DELETE FROM ai_unanswered_questions WHERE ${where}`;
    c.formAnswers = await tx.$executeRaw`DELETE FROM whatsapp_form_responses WHERE ${where}`;
    c.formSessions = await tx.$executeRaw`DELETE FROM whatsapp_form_sessions WHERE ${where}`;
    c.notifications = await tx.$executeRaw`DELETE FROM notifications WHERE ${where}`;
    c.contacts = await tx.$executeRaw`DELETE FROM contacts WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
    // Realtime copies of the contact, its conversations and messages, including the delete events just written.
    const refs = [contactId, ...conversations.map((r) => r.id)];
    c.realtimeEvents = await tx.$executeRaw`DELETE FROM outbox_events WHERE account_id=${accountId}::uuid AND (
      COALESCE(payload->'old'->>'id', payload->'new'->>'id') = ANY(${refs}::text[])
      OR COALESCE(payload->'old'->>'contact_id', payload->'new'->>'contact_id') = ${contactId}
      OR COALESCE(payload->'old'->>'conversation_id', payload->'new'->>'conversation_id') = ANY(${refs}::text[]))`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${accountId}::uuid,${requestedBy}::uuid,'contact.erased',${contactId},${JSON.stringify(c)}::jsonb)`;
    return c;
  }, worker);
  return counts;
}
