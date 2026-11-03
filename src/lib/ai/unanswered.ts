// ============================================================
// Unanswered questions: what customers asked that the AI agent could
// not answer, grouped so the team answers each one once and can teach
// the answer back to the agent.
//
// Roles (enforced by RLS on ai_unanswered_questions and checked here):
//   worker        records questions (recordUnanswered)
//   agent and up  list, answer, dismiss
//   admin and up  promote an answer into the knowledge base
// Question text is customer content: it is stored, never logged.
// ============================================================

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { hasMinRole } from '@/lib/auth/roles'
import type { DataClient } from '@/lib/data/types'
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant'
import { loadEmbeddingsKey } from './config'
import { ingestDocument } from './knowledge'

export const MAX_QUESTION_CHARS = 2000
export const MAX_ANSWER_CHARS = 4000
export type UnansweredStatus = 'open' | 'answered' | 'dismissed'

export class UnansweredError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
    this.name = 'UnansweredError'
  }
}

/**
 * The grouping key for a question: Unicode-normalised, lower-cased,
 * punctuation and symbols dropped, every run of digits folded to "#"
 * (so "order 1234?" and "Order 98765" group together) and whitespace
 * collapsed. Letters of every script are kept. Empty when nothing
 * meaningful is left (only emoji or punctuation).
 */
export function normalizeQuestion(question: string): string {
  return question
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\p{N}+/gu, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUESTION_CHARS)
}

export interface RecordUnansweredInput {
  accountId: string
  question: string
  conversationId?: string | null
  contactId?: string | null
}

/**
 * Record (or count again) an open question. Runs in the caller's
 * worker-role tenant transaction; the app role cannot insert. An open
 * question with the same normalised text is counted, not duplicated,
 * and keeps the latest phrasing and conversation. Returns null when
 * the text has nothing worth grouping.
 */
export async function recordUnanswered(
  tx: TenantTransaction,
  input: RecordUnansweredInput,
): Promise<{ id: string; occurrences: number } | null> {
  const question = input.question.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS)
  const normalized = normalizeQuestion(question)
  if (!question || !normalized || normalized === '#') return null
  const rows = await tx.$queryRaw<{ id: string; occurrences: number }[]>`
    INSERT INTO ai_unanswered_questions(account_id, conversation_id, contact_id, question, normalized_question)
    VALUES (${input.accountId}::uuid, ${input.conversationId ?? null}::uuid, ${input.contactId ?? null}::uuid,
      ${question}, ${normalized})
    ON CONFLICT (account_id, normalized_question) WHERE status = 'open' DO UPDATE SET
      occurrences = ai_unanswered_questions.occurrences + 1,
      last_asked_at = now(),
      question = EXCLUDED.question,
      conversation_id = COALESCE(EXCLUDED.conversation_id, ai_unanswered_questions.conversation_id),
      contact_id = COALESCE(EXCLUDED.contact_id, ai_unanswered_questions.contact_id)
    RETURNING id::text, occurrences`
  return rows[0] ?? null
}

export interface UnansweredQuestion {
  id: string
  conversation_id: string | null
  contact_id: string | null
  question: string
  occurrences: number
  last_asked_at: string
  status: UnansweredStatus
  answer: string | null
  answered_by: string | null
  answered_at: string | null
  promoted_document_id: string | null
  created_at: string
}

interface Row extends Omit<UnansweredQuestion, 'last_asked_at' | 'answered_at' | 'created_at'> {
  last_asked_at: Date
  answered_at: Date | null
  created_at: Date
}

const COLUMNS = `id::text, conversation_id::text, contact_id::text, question, occurrences, last_asked_at, status,
  answer, answered_by::text, answered_at, promoted_document_id::text, created_at`

const toQuestion = (r: Row): UnansweredQuestion => ({
  ...r,
  last_asked_at: r.last_asked_at.toISOString(),
  answered_at: r.answered_at ? r.answered_at.toISOString() : null,
  created_at: r.created_at.toISOString(),
})

function requireRole(ctx: TenantContext, minimum: 'agent' | 'admin') {
  if (!ctx.role || !hasMinRole(ctx.role, minimum)) {
    throw new UnansweredError(minimum === 'admin' ? 'Only admins can teach the AI agent' : 'Agents and above can manage unanswered questions', 403)
  }
}

const uuid = z.string().uuid()
const listSchema = z.object({
  status: z.enum(['open', 'answered', 'dismissed']).default('open'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(100_000).default(0),
}).strict()

/** Most-recently asked first. Agents and above. */
export async function listUnanswered(
  ctx: TenantContext,
  input: { status?: UnansweredStatus; limit?: number; offset?: number } = {},
): Promise<{ items: UnansweredQuestion[]; total: number }> {
  requireRole(ctx, 'agent')
  const parsed = listSchema.safeParse(input)
  if (!parsed.success) throw new UnansweredError(parsed.error.issues[0]?.message ?? 'Invalid request')
  const { status, limit, offset } = parsed.data
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRawUnsafe<Row[]>(
      `SELECT ${COLUMNS} FROM ai_unanswered_questions
       WHERE account_id=$1::uuid AND status=$2
       ORDER BY last_asked_at DESC, id LIMIT $3 OFFSET $4`,
      ctx.accountId, status, limit, offset,
    )
    const total = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ai_unanswered_questions WHERE account_id=${ctx.accountId}::uuid AND status=${status}`
    return { items: rows.map(toQuestion), total: total[0]?.n ?? 0 }
  })
}

/**
 * Save the team's answer (agents and above). Works on open questions
 * and on already-answered ones (to edit the answer). Null when the id
 * is not one of this workspace's questions or it was dismissed.
 */
export async function answerUnanswered(ctx: TenantContext, id: string, input: unknown): Promise<UnansweredQuestion | null> {
  requireRole(ctx, 'agent')
  if (!uuid.safeParse(id).success) return null
  const answer = typeof (input as { answer?: unknown } | null)?.answer === 'string'
    ? ((input as { answer: string }).answer).trim() : ''
  if (!answer) throw new UnansweredError('Enter an answer')
  if (answer.length > MAX_ANSWER_CHARS) throw new UnansweredError(`Answers are at most ${MAX_ANSWER_CHARS} characters`)
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRawUnsafe<Row[]>(
      `UPDATE ai_unanswered_questions SET status='answered', answer=$3, answered_by=$4::uuid, answered_at=now()
       WHERE account_id=$1::uuid AND id=$2::uuid AND status IN ('open','answered')
       RETURNING ${COLUMNS}`,
      ctx.accountId, id, answer, ctx.userId ?? null,
    )
    return rows[0] ? toQuestion(rows[0]) : null
  })
}

/** Dismiss an open question (agents and above). False when it is not an open question of this workspace. */
export async function dismissUnanswered(ctx: TenantContext, id: string): Promise<boolean> {
  requireRole(ctx, 'agent')
  if (!uuid.safeParse(id).success) return false
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE ai_unanswered_questions SET status='dismissed'
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid AND status='open' RETURNING id::text`
    return rows.length > 0
  })
}

/** The knowledge text a learned answer becomes. */
export function learnedDocumentContent(question: string, answer: string): string {
  return `Question: ${question.trim()}\nAnswer: ${answer.trim()}`
}

export interface PromoteResult {
  documentId: string
  sourceId: string
  /** False when the document was saved but chunking/embedding failed (reindex later). */
  indexed: boolean
}

/**
 * Teach an answered question to the agent (admins). Saves it as a
 * document of the workspace's single 'learning' knowledge source,
 * links it from the question and indexes it through ingestDocument.
 * Promoting again updates the same document in place. Null when the
 * id is not an answered question of this workspace.
 *
 * `reviewedAnswer` is the answer text the admin saw. Agents can still
 * edit answers, so the row's current answer must equal it (checked
 * under the row lock); otherwise a 409 asks the admin to reload, and
 * text no admin reviewed never reaches the knowledge base.
 *
 * The learning source's status and error are left alone when it
 * already exists, so a queued or running re-index (and an earlier
 * embedding error it is meant to repair) is not cancelled; the run
 * recounts its pages itself.
 *
 * `db` is a data client scoped to the same caller (the route's
 * requireRole client); indexing runs after the row is committed, as
 * in POST /api/ai/knowledge, so a failed embed leaves a document the
 * admin can reindex.
 */
export async function promoteToKnowledge(ctx: TenantContext, id: string, db: DataClient, reviewedAnswer: unknown): Promise<PromoteResult | null> {
  requireRole(ctx, 'admin')
  if (!uuid.safeParse(id).success) return null
  if (typeof reviewedAnswer !== 'string' || !reviewedAnswer.trim()) throw new UnansweredError('Send the answer you reviewed')
  const saved = await withTenant(ctx, async (tx) => {
    const q = (await tx.$queryRaw<{ question: string; answer: string | null; promoted_document_id: string | null }[]>`
      SELECT question, answer, promoted_document_id::text FROM ai_unanswered_questions
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid AND status='answered' FOR UPDATE`)[0]
    if (!q?.answer) return null
    if (q.answer !== reviewedAnswer.trim()) {
      throw new UnansweredError('The answer changed since you reviewed it. Reload and review it before teaching the agent.', 409)
    }
    // Insert the learning source only when missing; an existing one keeps its status, error and updated_at.
    const source = (await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ai_knowledge_sources(account_id, kind, title, status, created_by)
      VALUES (${ctx.accountId}::uuid, 'learning', 'Learned answers', 'ready', ${ctx.userId ?? null}::uuid)
      ON CONFLICT (account_id) WHERE kind = 'learning' DO NOTHING
      RETURNING id::text`)[0] ?? (await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM ai_knowledge_sources WHERE account_id=${ctx.accountId}::uuid AND kind='learning'`)[0]
    const title = q.question.replace(/\s+/g, ' ').trim().slice(0, 200)
    const content = learnedDocumentContent(q.question, q.answer)
    const hash = createHash('sha256').update(content).digest('hex')
    let documentId: string | undefined
    if (q.promoted_document_id) {
      documentId = (await tx.$queryRaw<{ id: string }[]>`
        UPDATE ai_knowledge_documents SET title=${title}, content=${content}, content_hash=${hash},
          source_id=${source.id}::uuid, fetched_at=now(), updated_at=now()
        WHERE account_id=${ctx.accountId}::uuid AND id=${q.promoted_document_id}::uuid RETURNING id::text`)[0]?.id
    }
    if (!documentId) {
      documentId = (await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ai_knowledge_documents(account_id, created_by, title, content, source_id, content_hash, fetched_at)
        VALUES (${ctx.accountId}::uuid, ${ctx.userId ?? null}::uuid, ${title}, ${content}, ${source.id}::uuid, ${hash}, now())
        RETURNING id::text`)[0].id
      await tx.$executeRaw`
        UPDATE ai_unanswered_questions SET promoted_document_id=${documentId}::uuid
        WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`
    }
    // A queued or running re-index recounts its own pages; only an idle source is refreshed here.
    // 'no_pages' is the one error a new page clears.
    await tx.$executeRaw`
      UPDATE ai_knowledge_sources SET pages_indexed=(SELECT count(*)::int FROM ai_knowledge_documents
          WHERE account_id=${ctx.accountId}::uuid AND source_id=${source.id}::uuid), last_crawled_at=now(),
        status=CASE WHEN status='failed' AND error='no_pages' THEN 'ready' ELSE status END,
        error=CASE WHEN error='no_pages' THEN NULL ELSE error END
      WHERE account_id=${ctx.accountId}::uuid AND id=${source.id}::uuid AND status NOT IN ('queued','crawling')`
    return { documentId, sourceId: source.id, content }
  })
  if (!saved) return null

  let indexed = true
  try {
    const { key } = await loadEmbeddingsKey(db, ctx.accountId)
    await ingestDocument(db, ctx.accountId, { embeddingsApiKey: key }, saved.documentId, saved.content)
  } catch (err) {
    // The document is saved; only indexing failed. No content in the log.
    console.error('[ai unanswered] indexing a learned answer failed:', err instanceof Error ? err.name : 'unknown')
    indexed = false
    // Show it on the source (re-index repairs it), unless a run is already doing that.
    await withTenant(ctx, (tx) => tx.$executeRaw`
      UPDATE ai_knowledge_sources SET error='embedding_partial'
      WHERE account_id=${ctx.accountId}::uuid AND id=${saved.sourceId}::uuid
        AND status NOT IN ('queued','crawling') AND error IS NULL`).catch(() => undefined)
  }
  return { documentId: saved.documentId, sourceId: saved.sourceId, indexed }
}
