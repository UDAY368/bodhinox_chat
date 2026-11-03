import type { DataClient } from '@/lib/data/types'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'
import type { RetrievalScores } from './confidence'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

interface MatchRow {
  id: string
  content: string
  distance?: number
  rank?: number
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: DataClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
  if (delErr) throw delErr

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((content, i) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: i,
    content,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

/** One retrieved chunk with its match scores and the document it came from. */
export interface ScoredKnowledgeChunk {
  id: string
  content: string
  /** Cosine distance from the semantic match (lower is closer), when semantic matched it. */
  distance?: number
  /** Rank from the lexical match (higher is better), when lexical matched it. */
  rank?: number
  document_id: string | null
  title: string | null
  source_url: string | null
}

export interface ScoredKnowledge {
  chunks: ScoredKnowledgeChunk[]
  /** Every score the two searches returned (for assessConfidence); null when nothing matched. */
  retrieval: RetrievalScores | null
}

interface RawMatches {
  matches: MatchRow[]
  retrieval: RetrievalScores | null
}

/**
 * Hybrid search shared by both retrieval entry points: semantic first
 * when an embeddings key is set, topped up with lexical matches to fill
 * `k`. Best-effort: any failure yields fewer or no matches. Only error
 * names are logged, never the query or chunk text.
 */
async function matchKnowledge(
  db: DataClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k: number,
): Promise<RawMatches> {
  const empty: RawMatches = { matches: [], retrieval: null }
  const query = queryText.trim()
  if (!query || k <= 0) return empty

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return empty
  } catch {
    return empty
  }

  const picked = new Map<string, MatchRow>() // preserves order
  const semanticDistances: number[] = []
  const lexicalRanks: number[] = []

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[]) {
            picked.set(row.id, { id: row.id, content: row.content, distance: row.distance })
            if (typeof row.distance === 'number') semanticDistances.push(row.distance)
          }
        }
      }
    } catch (err) {
      console.warn('[ai knowledge] semantic retrieval failed, falling back to FTS', { error: errorName(err) })
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (typeof row.rank === 'number') lexicalRanks.push(row.rank)
          const seen = picked.get(row.id)
          if (seen) {
            if (typeof row.rank === 'number') seen.rank = row.rank
          } else if (picked.size < k) {
            picked.set(row.id, { id: row.id, content: row.content, rank: row.rank })
          }
        }
      }
    } catch (err) {
      console.warn('[ai knowledge] lexical retrieval failed', { error: errorName(err) })
    }
  }

  const matches = [...picked.values()].slice(0, k).map((m) => ({
    id: m.id,
    content: m.content,
    ...(typeof m.distance === 'number' ? { distance: m.distance } : {}),
    ...(typeof m.rank === 'number' ? { rank: m.rank } : {}),
  }))
  if (!matches.length) return empty
  return { matches, retrieval: { semanticDistances, lexicalRanks } }
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, RPC error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: DataClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const { matches } = await matchKnowledge(db, accountId, config, queryText, k)
  return matches.map((m) => m.content)
}

/**
 * Same search as retrieveKnowledge, but keeps each chunk's match scores
 * (for assessConfidence) and the document it came from: id, title and
 * source url, never more of the document. Best-effort: a failed
 * document lookup leaves the document fields null.
 */
export async function retrieveKnowledgeScored(
  db: DataClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<ScoredKnowledge> {
  const { matches, retrieval } = await matchKnowledge(db, accountId, config, queryText, k)
  if (!matches.length) return { chunks: [], retrieval: null }
  const docs = await documentsFor(db, accountId, matches.map((m) => m.id))
  return {
    chunks: matches.map((m) => {
      const doc = docs.get(m.id)
      return {
        ...m,
        document_id: doc?.id ?? null,
        title: doc ? String(doc.title ?? '').slice(0, 200) : null,
        source_url: doc?.source_url ?? null,
      }
    }),
    retrieval,
  }
}

interface DocumentRef {
  id: string
  title: string
  source_url: string | null
}

/** chunk id → its document's id, title and url. Empty on any failure. */
async function documentsFor(db: DataClient, accountId: string, chunkIds: string[]): Promise<Map<string, DocumentRef>> {
  const out = new Map<string, DocumentRef>()
  try {
    const { data: chunks, error } = await db.from('ai_knowledge_chunks')
      .select('id, document_id').eq('account_id', accountId).in('id', chunkIds)
    if (error || !Array.isArray(chunks)) return out
    const docOf = new Map((chunks as Array<{ id: string; document_id: string }>).map((c) => [c.id, c.document_id]))
    const docIds = [...new Set([...docOf.values()].filter(Boolean))]
    if (!docIds.length) return out
    const { data: docs, error: docError } = await db.from('ai_knowledge_documents')
      .select('id, title, source_url').eq('account_id', accountId).in('id', docIds)
    if (docError || !Array.isArray(docs)) return out
    const byId = new Map((docs as DocumentRef[]).map((d) => [d.id, d]))
    for (const [chunkId, docId] of docOf) {
      const doc = byId.get(docId)
      if (doc) out.set(chunkId, doc)
    }
  } catch {
    // best-effort: no document fields
  }
  return out
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
