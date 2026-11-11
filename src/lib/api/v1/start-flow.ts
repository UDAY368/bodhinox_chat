// Stage 5 (5G): POST /api/v1/contacts/{id}/flows starts an active flow for a
// contact from outside (a lead pushed from a form, a CRM, Zapier).
//
// The route checks the key's workspace owns the contact and the flow, picks
// the contact's most recent conversation on a channel the flow runs on, and
// queues one `api.start_flow` job before answering 202. The job's dedupe key
// comes from the key id and the Idempotency-Key header, so a repeated request
// queues once; the job starts the run through startFlowById with a synthetic
// start event whose id is derived from the same key, so a retried job never
// starts a second run. The flow's own steps then apply every channel rule
// (the Instagram window is re-checked before each send).

import { createHash, randomUUID } from 'node:crypto';
import type { DataClient } from '@/lib/data/types';
import { enqueueJob } from '@/lib/jobs/queue';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { instagramAutomationAllowed } from '@/lib/contacts/channel-consent';

export const API_START_FLOW_JOB = 'api.start_flow';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A printable Idempotency-Key header of 1-200 characters. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

export type StartFlowRefusal = 'contact_not_found' | 'flow_not_active' | 'no_conversation' | 'bad_request';

export type StartFlowPrepared =
  | { ok: true; conversationId: string; channel: 'whatsapp' | 'instagram' }
  | { ok: false; reason: StartFlowRefusal };

/** The Idempotency-Key header when valid, null when absent; 'invalid' otherwise. */
export function idempotencyKeyOf(request: Request): string | null | 'invalid' {
  const raw = request.headers.get('idempotency-key');
  if (raw === null) return null;
  const value = raw.trim();
  return IDEMPOTENCY_KEY.test(value) ? value : 'invalid';
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);

/** Which channels a flow's channel_scope runs on. */
export function scopeChannels(scope: unknown): Array<'whatsapp' | 'instagram'> {
  if (scope === 'instagram') return ['instagram'];
  if (scope === 'any') return ['whatsapp', 'instagram'];
  return ['whatsapp'];
}

/**
 * Checks, with the key's tenant-scoped client, that the contact and the
 * active flow are this workspace's and finds the conversation to run on.
 */
export async function prepareStartFlow(db: DataClient, accountId: string, contactId: string, flowId: string): Promise<StartFlowPrepared> {
  if (!UUID.test(contactId)) return { ok: false, reason: 'contact_not_found' };
  if (!UUID.test(flowId)) return { ok: false, reason: 'bad_request' };
  const contact = await db.from('contacts').select('id').eq('id', contactId).eq('account_id', accountId).maybeSingle();
  if (contact.error) throw new Error('Contact lookup failed');
  if (!contact.data) return { ok: false, reason: 'contact_not_found' };
  const flow = await db.from('flows').select('id, status, channel_scope').eq('id', flowId).eq('account_id', accountId).maybeSingle();
  if (flow.error) throw new Error('Flow lookup failed');
  const row = flow.data as { status?: string; channel_scope?: string | null } | null;
  if (!row || row.status !== 'active') return { ok: false, reason: 'flow_not_active' };
  const channels = scopeChannels(row.channel_scope ?? 'whatsapp');
  const conversations = await db.from('conversations').select('id, channel, last_message_at')
    .eq('account_id', accountId).eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false }).limit(20);
  if (conversations.error) throw new Error('Conversation lookup failed');
  for (const c of (conversations.data ?? []) as Array<{ id: string; channel: string | null }>) {
    const channel = c.channel === 'instagram' ? 'instagram' : 'whatsapp';
    if (channels.includes(channel)) return { ok: true, conversationId: c.id, channel };
  }
  return { ok: false, reason: 'no_conversation' };
}

/** Queues the start (before the 202). One job per key id and Idempotency-Key; a fresh one without the header. */
export async function queueStartFlow(args: { accountId: string; keyId: string; idempotencyKey: string | null; contactId: string;
  conversationId: string; flowId: string }): Promise<string> {
  const request = args.idempotencyKey ? digest(`${args.keyId}:${args.idempotencyKey}`) : randomUUID().replace(/-/g, '');
  return enqueueJob(API_START_FLOW_JOB, {
    contactId: args.contactId, conversationId: args.conversationId, flowId: args.flowId, request,
    fingerprint: digest(`${args.contactId}:${args.flowId}`),
  }, { tenantId: args.accountId, dedupeKey: `api-flow:${args.accountId}:${request}` });
}

/** The fingerprint of a queued job's request, to tell a repeated key from a reused one. */
export async function queuedFingerprint(accountId: string, jobId: string): Promise<string | null> {
  const rows = await getWorkerPrisma().$queryRaw<{ fingerprint: string | null }[]>`
    SELECT payload->>'fingerprint' AS fingerprint FROM jobs WHERE id=${jobId}::uuid AND tenant_id=${accountId}::uuid`;
  return rows[0]?.fingerprint ?? null;
}

/** The `api.start_flow` job. Ids are re-checked inside the job's tenant; a stale request is a no-op. */
export async function handleApiStartFlowJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const { contactId, conversationId, flowId, request } = payload;
  if (typeof contactId !== 'string' || !UUID.test(contactId) || typeof conversationId !== 'string' || !UUID.test(conversationId)
    || typeof flowId !== 'string' || !UUID.test(flowId) || typeof request !== 'string' || !/^[a-f0-9]{32,40}$/.test(request))
    throw new Error('Invalid api.start_flow contract');
  const flow = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ user_id: string; channel: string | null }[]>`
    SELECT f.user_id::text AS user_id, c.channel FROM flows f
    JOIN conversations c ON c.account_id=f.account_id AND c.id=${conversationId}::uuid AND c.contact_id=${contactId}::uuid
    WHERE f.account_id=${accountId}::uuid AND f.id=${flowId}::uuid AND f.status='active'`, getWorkerPrisma());
  if (!flow[0]) {
    console.info('[api start flow] skipped', { reason: 'flow_or_conversation_gone' });
    return;
  }
  // A contact unsubscribed from Instagram automation gets no flow there.
  if (flow[0].channel === 'instagram' && !(await instagramAutomationAllowed(accountId, contactId))) {
    console.info('[api start flow] skipped', { reason: 'instagram_opted_out' });
    return;
  }
  // Imported lazily: the engine's module graph is large.
  const { startFlowById } = await import('@/lib/flows/engine');
  const result = await startFlowById({
    accountId, userId: flow[0].user_id, contactId, conversationId, flowId,
    // The synthetic start event: its id makes a retried job a duplicate, never a second run.
    message: { kind: 'text', text: '', meta_message_id: `api-start:${request}` },
  });
  console.info('[api start flow] done', { outcome: result.outcome });
}
