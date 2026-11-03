import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DataClient } from '@/lib/data/types'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

import { retrieveKnowledge, retrieveKnowledgeScored, ingestDocument } from './knowledge'

interface FakeState {
  semantic: { id: string; content: string }[]
  fts: { id: string; content: string }[]
  chunkCount: number
  rpcCalls: string[]
  inserted: Record<string, unknown>[] | null
  deletedFor: string | null
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 5, // account has a non-empty KB by default
    rpcCalls: [],
    inserted: null,
    deletedFor: null,
  }
  const db = {
    rpc: (name: string) => {
      state.rpcCalls.push(name)
      if (name === 'match_ai_knowledge_semantic')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts')
        return Promise.resolve({ data: state.fts, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard.
      select: () => ({
        eq: () => Promise.resolve({ count: state.chunkCount, error: null }),
      }),
      delete: () => ({
        eq: (_col: string, val: string) => {
          state.deletedFor = val
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as DataClient, state }
}

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, '  ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q')
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'q')
    expect(out).toEqual(['F1'])
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
      { id: 's3', content: 'S3' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    // Enough semantic hits → no FTS top-up.
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_semantic'])
  })

  it('tops up with FTS and dedupes when semantic is short', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
    ]
    state.fts = [
      { id: 's2', content: 'S2-dup' }, // dedup by id
      { id: 'f1', content: 'F1' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'F1'])
    expect(state.rpcCalls).toEqual([
      'match_ai_knowledge_semantic',
      'match_ai_knowledge_fts',
    ])
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', '   ')
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))
    await expect(
      ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world'),
    ).rejects.toThrow('rate limited')
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })
})

describe('retrieveKnowledgeScored', () => {
  function scoredDb(opts: {
    semantic?: { id: string; content: string; distance: number }[]
    fts?: { id: string; content: string; rank: number }[]
    chunkDocs?: Record<string, string>
    docs?: { id: string; title: string; source_url: string | null; account_id?: string }[]
    failDocs?: boolean
  }) {
    const tables: string[] = []
    const db = {
      rpc: (name: string) => Promise.resolve({
        data: name === 'match_ai_knowledge_semantic' ? opts.semantic ?? [] : opts.fts ?? [],
        error: null,
      }),
      from: (table: string) => {
        tables.push(table)
        return {
          select: () => ({
            eq: () => Object.assign(Promise.resolve({ count: 3, error: null }), {
              in: (_col: string, ids: string[]) => {
                if (table === 'ai_knowledge_chunks') {
                  return Promise.resolve({
                    data: ids.filter((id) => opts.chunkDocs?.[id]).map((id) => ({ id, document_id: opts.chunkDocs![id] })),
                    error: null,
                  })
                }
                if (opts.failDocs) return Promise.resolve({ data: null, error: { code: 'XX000' } })
                return Promise.resolve({ data: (opts.docs ?? []).filter((d) => ids.includes(d.id)), error: null })
              },
            }),
          }),
        }
      },
    }
    return { db: db as unknown as DataClient, tables }
  }

  it('keeps semantic distances, lexical ranks and each chunk\'s document', async () => {
    const { db } = scoredDb({
      semantic: [{ id: 's1', content: 'S1', distance: 0.3 }],
      fts: [{ id: 's1', content: 'S1', rank: 1.5 }, { id: 'f1', content: 'F1', rank: 0.7 }],
      chunkDocs: { s1: 'd1', f1: 'd2' },
      docs: [{ id: 'd1', title: 'Shipping', source_url: 'https://acme.test/ship' }, { id: 'd2', title: 'FAQ', source_url: null }],
    })
    const out = await retrieveKnowledgeScored(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out.retrieval).toEqual({ semanticDistances: [0.3], lexicalRanks: [1.5, 0.7] })
    expect(out.chunks).toEqual([
      { id: 's1', content: 'S1', distance: 0.3, rank: 1.5, document_id: 'd1', title: 'Shipping', source_url: 'https://acme.test/ship' },
      { id: 'f1', content: 'F1', rank: 0.7, document_id: 'd2', title: 'FAQ', source_url: null },
    ])
  })

  it('returns no chunks and null retrieval when nothing matched', async () => {
    const { db, tables } = scoredDb({})
    expect(await retrieveKnowledgeScored(db, 'acct', { embeddingsApiKey: null }, 'q')).toEqual({ chunks: [], retrieval: null })
    expect(tables).not.toContain('ai_knowledge_documents')
  })

  it('leaves document fields null when the document lookup fails', async () => {
    const { db } = scoredDb({ fts: [{ id: 'f1', content: 'F1', rank: 1 }], chunkDocs: { f1: 'd1' }, failDocs: true })
    const out = await retrieveKnowledgeScored(db, 'acct', { embeddingsApiKey: null }, 'q')
    expect(out.chunks).toEqual([{ id: 'f1', content: 'F1', rank: 1, document_id: null, title: null, source_url: null }])
  })

  it('logs only an error name when semantic search fails, never the query', async () => {
    h.embedTexts.mockRejectedValue(new Error('embedding failed for: secret customer question'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db } = scoredDb({ fts: [{ id: 'f1', content: 'F1', rank: 1 }] })
    await retrieveKnowledgeScored(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'secret customer question')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret customer question')
    warn.mockRestore()
  })
})
