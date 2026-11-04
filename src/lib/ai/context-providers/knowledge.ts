// 'knowledge' context: knowledge-base excerpts for the request's query,
// through the audience-aware retrieval (v2 RPCs). 'customer' returns only
// customer-facing sources and drops chunks with injection markers; 'staff'
// also returns admin-only sources the member may read, and is refused for a
// worker-role request by the database. Best-effort: retrieval failures give
// no excerpts. Excerpts are untrusted 'knowledge' blocks with citations.

import { loadEmbeddingsKey } from '../config';
import { retrieveKnowledgeScored } from '../knowledge';
import { databaseAdmin } from '../admin-client';
import { emptyContext, type ContextProvider } from './core';
import { dataClientFor } from './scope';

const K = 5;

export const knowledgeProvider: ContextProvider = {
  key: 'knowledge',
  minRole: 'agent',
  audiences: ['customer', 'staff'],
  async load(request) {
    const out = emptyContext();
    const query = request.query?.trim();
    if (!query) return out;
    // The embeddings key is read on the worker (members cannot read ai_configs keys); FTS when there is none.
    const { key } = await loadEmbeddingsKey(databaseAdmin({ accountId: request.accountId, role: 'owner' }), request.accountId)
      .catch(() => ({ key: null }));
    const scored = await retrieveKnowledgeScored(dataClientFor(request), request.accountId, { embeddingsApiKey: key }, query, K, request.audience);
    scored.chunks.forEach((chunk, i) => {
      out.blocks.push({ source: 'knowledge', label: chunk.title ? `excerpt ${i + 1}: ${chunk.title}` : `excerpt ${i + 1}`, text: chunk.content });
    });
    out.citations.push(...scored.citations);
    out.facts.knowledge_excerpts = scored.chunks.length;
    return out;
  },
};
