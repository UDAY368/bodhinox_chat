import type { DataClient } from '@/lib/data/types'
import type { AiConfig, KnowledgeAudience, KnowledgeCitation } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'
import type { RetrievalScores } from './confidence'
import { detectInjectionMarkers } from './safety/untrusted'
import { redactForProvider } from './safety/redact'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
//
// Retrieval is audience-aware (Phase 13): 'customer' returns only sources
// marked customer-facing and visible to agents, and drops chunks that carry
// prompt-injection markers; 'staff' returns what the calling member's role
// may read (the database refuses it on the worker).
// ============================================================

interface MatchRow {
  id: string
  content: string
  document_id?: string | null
  source_id?: string | null
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
  /** The knowledge source the document belongs to; null for legacy typed documents. */
  source_id: string | null
  title: string | null
  source_url: string | null
}

export interface ScoredKnowledge {
  chunks: ScoredKnowledgeChunk[]
  /** Every score the two searches returned (for assessConfidence); null when nothing matched. */
  retrieval: RetrievalScores | null
  /** What grounded the answer, one per chunk, for display next to it. */
  citations: KnowledgeCitation[]
}

interface RawMatches {
  matches: Array<Pick<ScoredKnowledgeChunk, 'id' | 'content' | 'document_id' | 'source_id' | 'distance' | 'rank'>>
  retrieval: RetrievalScores | null
}

/**
 * Hybrid search shared by both retrieval entry points: semantic first
 * when an embeddings key is set, topped up with lexical matches to fill
 * `k`, through the audience-aware v2 RPCs. Best-effort: any failure yields
 * fewer or no matches. Only error names are logged, never the query or
 * chunk text.
 */
async function matchKnowledge(
  db: DataClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k: number,
  audience: KnowledgeAudience,
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
  // A chunk that tries to instruct the model never grounds customer text.
  const usable = (row: MatchRow) =>
    audience !== 'customer' || detectInjectionMarkers(String(row.content ?? '')).length === 0

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      // The embeddings provider is a provider call: personal data in the
      // customer's text is masked first. The FTS query below stays raw (it
      // never leaves the database).
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [redactForProvider(query).text])
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic_v2', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
          p_audience: audience,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[]) {
            if (!usable(row)) continue
            picked.set(row.id, { id: row.id, content: row.content, document_id: row.document_id, source_id: row.source_id, distance: row.distance })
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
      const { data, error } = await db.rpc('match_ai_knowledge_fts_v2', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
        p_audience: audience,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (!usable(row)) continue
          if (typeof row.rank === 'number') lexicalRanks.push(row.rank)
          const seen = picked.get(row.id)
          if (seen) {
            if (typeof row.rank === 'number') seen.rank = row.rank
          } else if (picked.size < k) {
            picked.set(row.id, { id: row.id, content: row.content, document_id: row.document_id, source_id: row.source_id, rank: row.rank })
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
    document_id: m.document_id ?? null,
    source_id: m.source_id ?? null,
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
 * `audience` defaults to 'customer', the narrower set.
 */
export async function retrieveKnowledge(
  db: DataClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
  audience: KnowledgeAudience = 'customer',
): Promise<string[]> {
  const { matches } = await matchKnowledge(db, accountId, config, queryText, k, audience)
  return matches.map((m) => m.content)
}

/**
 * Same search as retrieveKnowledge, but keeps each chunk's match scores
 * (for assessConfidence), the document it came from (id, source, title and
 * source url, never more of the document) and one citation per chunk.
 * Best-effort: a failed document lookup leaves the title and url null.
 */
export async function retrieveKnowledgeScored(
  db: DataClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
  audience: KnowledgeAudience = 'customer',
): Promise<ScoredKnowledge> {
  const { matches, retrieval } = await matchKnowledge(db, accountId, config, queryText, k, audience)
  if (!matches.length) return { chunks: [], retrieval: null, citations: [] }
  const docs = await documentsFor(db, accountId, matches.map((m) => m.document_id).filter((d): d is string => !!d))
  const chunks: ScoredKnowledgeChunk[] = matches.map((m) => {
    const doc = m.document_id ? docs.get(m.document_id) : undefined
    return {
      ...m,
      title: doc ? String(doc.title ?? '').slice(0, 200) : null,
      source_url: doc?.source_url ?? null,
    }
  })
  return { chunks, retrieval, citations: chunks.map(citationOf) }
}

/** The citation shown for one retrieved chunk. */
export function citationOf(chunk: ScoredKnowledgeChunk): KnowledgeCitation {
  return {
    chunk_id: chunk.id,
    document_id: chunk.document_id,
    source_id: chunk.source_id,
    title: chunk.title,
    source_url: chunk.source_url,
  }
}

interface DocumentRef {
  id: string
  title: string
  source_url: string | null
}

/** document id → its title and url, read through the document policy. Empty on any failure. */
async function documentsFor(db: DataClient, accountId: string, documentIds: string[]): Promise<Map<string, DocumentRef>> {
  const out = new Map<string, DocumentRef>()
  const ids = [...new Set(documentIds)]
  if (!ids.length) return out
  try {
    const { data: docs, error } = await db.from('ai_knowledge_documents')
      .select('id, title, source_url').eq('account_id', accountId).in('id', ids)
    if (error || !Array.isArray(docs)) return out
    for (const doc of docs as DocumentRef[]) out.set(doc.id, doc)
  } catch {
    // best-effort: no document fields
  }
  return out
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
