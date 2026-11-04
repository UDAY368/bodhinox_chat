// Database access for advisory assessments (ai_assessments). Every function
// runs inside the caller's tenant transaction: the job uses the worker client
// (withTenant on getWorkerPrisma), the routes the member's app client, where
// RLS lets agents and above read and nobody but the worker write.
//
// The only table written is ai_assessments (plus a jobs row for a refresh).

import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { dataError } from '@/lib/data/errors';
import type { AssessIntent, CrmFacts, QualificationFlags, TranscriptMessage } from './classify';
import { AI_ASSESS_JOB, AI_ASSESS_SLOT_MS } from './job-contract';

export interface AssessmentQualification extends QualificationFlags {
  /** Messages the intent rests on (a subset of source_message_ids). */
  evidence_message_ids: string[];
  /** Health categories found: the UI shows the route-to-staff banner. */
  sensitive_categories: string[];
  route_to_staff: boolean;
  /** Guard flags from the model call (pii_redacted, claim_replaced, evidence_dropped, ...). */
  flags: string[];
}

export interface NewAssessment {
  accountId: string;
  contactId: string;
  conversationId: string;
  intent: AssessIntent;
  intentConfidence: number;
  leadScore: number | null;
  qualification: AssessmentQualification;
  rationale: string;
  sourceMessageIds: string[];
  source: 'model' | 'deterministic';
  model: string | null;
  promptVersion: string;
}

export interface AssessmentView {
  id: string;
  contact_id: string;
  conversation_id: string;
  intent: AssessIntent;
  intent_confidence: number;
  lead_score: number | null;
  qualification: AssessmentQualification;
  rationale: string;
  source: 'model' | 'deterministic';
  created_at: string;
}

interface ConversationRow { contact_id: string }
interface MessageRow { id: string; sender_type: string; content_text: string | null; created_at: Date }

/** The conversation's contact and its latest text messages (oldest first), or null when not found. */
export async function readConversationForAssessment(
  tx: TenantTransaction, accountId: string, conversationId: string, limit: number,
): Promise<{ contactId: string; messages: TranscriptMessage[] } | null> {
  const conv = await tx.$queryRaw<ConversationRow[]>`SELECT contact_id::text AS contact_id FROM conversations
    WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`;
  if (!conv[0]) return null;
  const n = Math.max(1, Math.min(40, Math.floor(limit)));
  const rows = await tx.$queryRaw<MessageRow[]>`SELECT id::text AS id, sender_type, content_text, created_at FROM messages
    WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid
      AND content_text IS NOT NULL AND btrim(content_text) <> ''
    ORDER BY created_at DESC, id DESC LIMIT ${n}`;
  const messages = rows.reverse().map((r) => ({
    id: r.id,
    sender: (r.sender_type === 'customer' ? 'customer' : r.sender_type === 'bot' ? 'bot' : 'agent') as TranscriptMessage['sender'],
    text: r.content_text ?? '',
    createdAt: r.created_at.toISOString(),
  }));
  return { contactId: conv[0].contact_id, messages };
}

/** CRM facts for the lead score: an open deal, inbound volume (capped at 100) and the latest inbound time. */
export async function readCrmFacts(tx: TenantTransaction, accountId: string, contactId: string, conversationId: string): Promise<CrmFacts> {
  const [row] = await tx.$queryRaw<{ open_deal: boolean; inbound: number; last_inbound: Date | null }[]>`SELECT
    EXISTS(SELECT 1 FROM deals WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid
      AND COALESCE(status,'open')='open') AS open_deal,
    (SELECT count(*)::int FROM (SELECT 1 FROM messages WHERE account_id=${accountId}::uuid
      AND conversation_id=${conversationId}::uuid AND sender_type='customer' LIMIT 100) s) AS inbound,
    (SELECT created_at FROM messages WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid
      AND sender_type='customer' ORDER BY created_at DESC LIMIT 1) AS last_inbound`;
  return { openDeal: !!row?.open_deal, customerMessages: row?.inbound ?? 0, lastInboundAt: row?.last_inbound ?? null };
}

/**
 * Supersedes the conversation's current assessment and inserts the new one, in
 * the caller's (worker) transaction. Two writers race on the partial unique
 * index; the loser raises a unique violation (isUniqueViolation) and retries.
 */
export async function replaceAssessment(tx: TenantTransaction, row: NewAssessment): Promise<string> {
  await tx.$executeRaw`UPDATE ai_assessments SET superseded_at=now()
    WHERE account_id=${row.accountId}::uuid AND conversation_id=${row.conversationId}::uuid AND superseded_at IS NULL`;
  const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO ai_assessments(account_id, contact_id, conversation_id,
      intent, intent_confidence, lead_score, qualification, rationale, source_message_ids, source, model, prompt_version)
    VALUES(${row.accountId}::uuid, ${row.contactId}::uuid, ${row.conversationId}::uuid, ${row.intent},
      ${row.intentConfidence}::smallint, ${row.leadScore}::smallint, ${JSON.stringify(row.qualification)}::jsonb,
      ${row.rationale.slice(0, 400)}, ${row.sourceMessageIds.slice(-40)}::uuid[], ${row.source}, ${row.model}, ${row.promptVersion})
    RETURNING id::text AS id`;
  return inserted[0].id;
}

/** True for a Postgres unique violation surfaced by Prisma raw queries. */
export function isUniqueViolation(error: unknown): boolean {
  return !!error && dataError(error).code === '23505';
}

const VIEW_COLUMNS = Prisma.sql`id::text AS id, contact_id::text AS contact_id, conversation_id::text AS conversation_id, intent,
  intent_confidence::int AS intent_confidence, lead_score::int AS lead_score, qualification, rationale, source, created_at`;

interface ViewRow extends Omit<AssessmentView, 'created_at'> { created_at: Date }
const toView = (r: ViewRow): AssessmentView => ({ ...r, created_at: r.created_at.toISOString() });

/** The conversation's current assessment, or null. */
export async function readCurrentAssessment(tx: TenantTransaction, accountId: string, conversationId: string): Promise<AssessmentView | null> {
  const rows = await tx.$queryRaw<ViewRow[]>(Prisma.sql`SELECT ${VIEW_COLUMNS} FROM ai_assessments
    WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid AND superseded_at IS NULL`);
  return rows[0] ? toView(rows[0]) : null;
}

/** The newest current assessment per contact, for the given contacts. */
export async function readContactAssessments(tx: TenantTransaction, accountId: string, contactIds: readonly string[]): Promise<AssessmentView[]> {
  if (!contactIds.length) return [];
  const rows = await tx.$queryRaw<ViewRow[]>(Prisma.sql`SELECT DISTINCT ON (contact_id) ${VIEW_COLUMNS} FROM ai_assessments
    WHERE account_id=${accountId}::uuid AND contact_id = ANY(${[...contactIds]}::uuid[]) AND superseded_at IS NULL
    ORDER BY contact_id, created_at DESC`);
  return rows.map(toView);
}

/** True when the conversation exists in the caller's workspace (RLS-scoped). */
export async function conversationExists(tx: TenantTransaction, accountId: string, conversationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM conversations
    WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`;
  return rows.length > 0;
}

/**
 * Queues a manual refresh in the caller's tenant transaction (the app role may
 * insert its own tenant's jobs). One manual run per conversation per 10-minute
 * slot, run now; a second click in the slot is 'already_queued'.
 */
export async function queueAssessmentRefresh(
  tx: TenantTransaction, accountId: string, conversationId: string, now: number = Date.now(),
): Promise<'queued' | 'already_queued'> {
  const slot = Math.floor(now / AI_ASSESS_SLOT_MS);
  const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO jobs(type, tenant_id, payload, dedupe_key, run_at, max_attempts)
    VALUES(${AI_ASSESS_JOB}, ${accountId}::uuid, ${JSON.stringify({ conversationId })}::jsonb,
      ${`ai-assess-manual:${conversationId}:${slot}`}, now(), 3)
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id::text AS id`;
  return rows.length ? 'queued' : 'already_queued';
}
