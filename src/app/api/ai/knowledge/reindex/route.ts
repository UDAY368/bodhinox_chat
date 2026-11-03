import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { queueReindexAllSources } from '@/lib/ai/knowledge-sources'
import { AiError } from '@/lib/ai/types'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/knowledge/reindex  (admin+)
 *
 * Re-chunk and re-embed the account's knowledge. The main use is after
 * adding an embeddings key: existing documents were stored lexical-only,
 * and this backfills their vectors so semantic search turns on. Also
 * recovers documents whose indexing failed earlier.
 *
 * Manual documents (no source) are re-indexed here. Documents that
 * belong to a knowledge source (crawled pages, files, text, learned
 * answers) are re-indexed by the 'ai.crawl_source' worker: one run per
 * source that is not already running is queued, durably, before the
 * response, so this request never loops over crawled pages or races a
 * run on the same documents. Without a key nothing is queued (the runs
 * would only mark their sources failed).
 */
export async function POST() {
  try {
    const { db, accountId, userId, role } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      db,
      accountId,
    )
    // The whole point of Reindex is usually to backfill embeddings — so
    // if a key is configured but can't be decrypted, don't quietly do a
    // lexical-only pass and report success. Stop and tell the admin.
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          reindexed: 0,
          error:
            t('ai.knowledge.reindexKeyCorrupt'),
        },
        { status: 200 },
      )
    }

    const queuedSources = embeddingsApiKey
      ? await queueReindexAllSources({ accountId, userId, role })
      : 0

    const { data: docs, error } = await db
      .from('ai_knowledge_documents')
      .select('id, content')
      .eq('account_id', accountId)
      .is('source_id', null)
    if (error) {
      console.error('[ai/knowledge/reindex] fetch error:', error)
      return NextResponse.json(
        { error: t('ai.knowledge.loadDocsFailed') },
        { status: 500 },
      )
    }

    let reindexed = 0
    for (const doc of docs ?? []) {
      try {
        await ingestDocument(db, accountId, { embeddingsApiKey }, doc.id, doc.content)
        reindexed += 1
      } catch (err) {
        // Stop at the first failure (e.g. an embeddings rate limit) and report how far it got.
        const message = err instanceof AiError ? err.message : String(err)
        console.error(`[ai/knowledge/reindex] doc ${doc.id} failed:`, message)
        return NextResponse.json(
          {
            success: false,
            reindexed,
            queuedSources,
            total: (docs ?? []).length,
            error: t('ai.knowledge.reindexPartial', { reindexed, message }),
          },
          { status: 200 },
        )
      }
    }

    return NextResponse.json({ success: true, reindexed, queuedSources })
  } catch (err) {
    return toErrorResponse(err)
  }
}
