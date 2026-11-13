// "Ask the knowledge base" (AI page, Knowledge tab): what the AI would find
// for a question, before a customer asks it. Runs the same hybrid retrieval
// the agents use (semantic with an embeddings key, lexical otherwise) over
// everything staff may see, and returns the best match with its source, a
// match percentage and whether that source is used in customer replies.
//
// Nothing is generated and nothing is stored or logged: the question and the
// matched text only travel in the response. Below admin, an admin-only source
// is never returned (as in the source list).

import { hasMinRole, type AccountRole } from '@/lib/auth/roles'
import type { DataClient } from '@/lib/data/types'
import { withTenant } from '@/lib/db/tenant'
import { loadEmbeddingsKey } from './config'
import { retrievalScore } from './confidence'
import { retrieveKnowledgeScored, type ScoredKnowledgeChunk } from './knowledge'
import { parseQaDocument } from './knowledge-sources'

export const ASK_MAX_CHARS = 200
/** Below this score (0..1) the best match is reported as no match. */
export const ASK_MIN_SCORE = 0.15
const SNIPPET_CHARS = 1200

export interface AskMatch {
  text: string
  /** Set when the match is a Q&A source: its question. */
  question: string | null
  /** 0..100 */
  match: number
  document_title: string | null
  source: { id: string; title: string; kind: string; qa: boolean; customer_facing: boolean } | null
}

/** A chunk's own 0..1 score, from the same scale assessConfidence uses. */
export function chunkScore(chunk: Pick<ScoredKnowledgeChunk, 'distance' | 'rank'>): number {
  return retrievalScore({
    semanticDistances: typeof chunk.distance === 'number' ? [chunk.distance] : [],
    lexicalRanks: typeof chunk.rank === 'number' ? [chunk.rank] : [],
  })
}

/** The question in a request body: trimmed, 1..ASK_MAX_CHARS characters, or null. */
export function parseAskQuestion(body: unknown): string | null {
  const q = (body as { question?: unknown } | null)?.question
  if (typeof q !== 'string') return null
  const text = q.replace(/\s+/g, ' ').trim()
  return text.length >= 1 && text.length <= ASK_MAX_CHARS ? text : null
}

/** The best match for `question` the member may see, or null. */
export async function askKnowledge(ctx: { db: DataClient; accountId: string; userId: string; role: AccountRole }, question: string): Promise<AskMatch | null> {
  const { key } = await loadEmbeddingsKey(ctx.db, ctx.accountId).catch(() => ({ key: null }))
  const { chunks } = await retrieveKnowledgeScored(ctx.db, ctx.accountId, { embeddingsApiKey: key }, question, 5, 'staff')
  if (!chunks.length) return null
  const ids = [...new Set(chunks.map((c) => c.source_id).filter((id): id is string => !!id))]
  const sources = ids.length
    ? await withTenant({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, (tx) => tx.$queryRaw<
      { id: string; title: string; kind: string; qa: boolean; customer_facing: boolean; min_role: string }[]>`
      SELECT id::text, title, kind, qa, customer_facing, min_role FROM ai_knowledge_sources
      WHERE account_id=${ctx.accountId}::uuid AND id = ANY(${ids}::uuid[])`)
    : []
  const byId = new Map(sources.map((s) => [s.id, s]))
  const admin = hasMinRole(ctx.role, 'admin')
  const ranked = chunks
    .filter((c) => {
      const s = c.source_id ? byId.get(c.source_id) : undefined
      return admin || !s || s.min_role !== 'admin'
    })
    .map((c) => ({ chunk: c, score: chunkScore(c) }))
    .sort((a, b) => b.score - a.score)
  const best = ranked[0]
  if (!best || best.score < ASK_MIN_SCORE) return null
  const s = best.chunk.source_id ? byId.get(best.chunk.source_id) : undefined
  const qa = s?.qa ? parseQaDocument(best.chunk.content) : null
  return {
    text: (qa?.answer ?? best.chunk.content).slice(0, SNIPPET_CHARS),
    question: qa?.question ?? null,
    match: Math.round(best.score * 100),
    document_title: best.chunk.title,
    source: s ? { id: s.id, title: s.title, kind: s.kind, qa: s.qa, customer_facing: s.customer_facing } : null,
  }
}
