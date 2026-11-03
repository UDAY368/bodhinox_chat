// Pure helpers for the knowledge sources panel (kept out of the component so they are unit-tested).

export type SourceKind = 'website' | 'sitemap' | 'file' | 'text' | 'learning'
export type SourceStatus = 'queued' | 'crawling' | 'ready' | 'failed' | 'disabled'

export interface KnowledgeSourceView {
  id: string
  kind: SourceKind
  url: string | null
  title: string
  status: SourceStatus
  page_limit: number
  pages_indexed: number
  last_crawled_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

/** Reason codes the worker stores in `error`; anything else is shown as a generic failure. */
export const SOURCE_REASONS = [
  'embeddings_key_missing', 'embeddings_key_corrupt', 'invalid_url', 'blocked', 'robots_disallowed', 'robots_unreachable',
  'no_pages', 'embedding_failed', 'embedding_partial',
] as const
export type SourceReason = (typeof SOURCE_REASONS)[number]

export function sourceReason(error: string | null): SourceReason | 'unknown' | null {
  if (!error) return null
  return (SOURCE_REASONS as readonly string[]).includes(error) ? (error as SourceReason) : 'unknown'
}

export const isRunning = (s: Pick<KnowledgeSourceView, 'status'>) => s.status === 'queued' || s.status === 'crawling'

/** Poll while any source is queued or crawling. */
export const shouldPoll = (sources: Pick<KnowledgeSourceView, 'status'>[]) => sources.some(isRunning)

export function statusVariant(status: SourceStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ready') return 'default'
  if (status === 'failed') return 'destructive'
  if (status === 'disabled') return 'outline'
  return 'secondary'
}

/** Website and sitemap sources fetch pages; the others are re-indexed from stored text. */
export const isCrawled = (kind: SourceKind) => kind === 'website' || kind === 'sitemap'

export const ACCEPTED_UPLOADS = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown'
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
