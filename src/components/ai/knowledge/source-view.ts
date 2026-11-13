// Pure helpers for the knowledge sources panel (kept out of the component so they are unit-tested).

export type SourceKind = 'website' | 'sitemap' | 'file' | 'text' | 'learning'
export type SourceStatus = 'queued' | 'crawling' | 'ready' | 'failed' | 'disabled'

export type SourceMinRole = 'agent' | 'admin'

export interface KnowledgeSourceView {
  id: string
  kind: SourceKind
  /** A text source written as one question and its answer. */
  qa?: boolean
  url: string | null
  title: string
  status: SourceStatus
  page_limit: number
  pages_indexed: number
  last_crawled_at: string | null
  error: string | null
  /** Who may see the source: agents and above, or admins only. */
  min_role: SourceMinRole
  /** Whether the source may ground customer replies (never for an admin-only source). */
  customer_facing: boolean
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

export type AccessPatch = { min_role?: SourceMinRole; customer_facing?: boolean }

/**
 * The access a source has after a change, as the server applies it: making a
 * source admin-only also turns customer use off; customer use cannot be
 * turned on for an admin-only source (null: not allowed).
 */
export function nextAccess(source: Pick<KnowledgeSourceView, 'min_role' | 'customer_facing'>, patch: AccessPatch):
  { min_role: SourceMinRole; customer_facing: boolean } | null {
  const min_role = patch.min_role ?? source.min_role
  const customer_facing = patch.customer_facing ?? (patch.min_role === 'admin' ? false : source.customer_facing)
  return customer_facing && min_role !== 'agent' ? null : { min_role, customer_facing }
}

// ---------------------------------------------------------------- AI page table

/** The type chips of the sources table. */
export type SourceGroup = 'all' | 'website' | 'document' | 'qa'
export const SOURCE_GROUPS: readonly SourceGroup[] = ['all', 'website', 'document', 'qa']

/** Websites and sitemaps; uploaded files and typed text; Q&A pairs and answers learned from the inbox. */
export function sourceGroup(source: Pick<KnowledgeSourceView, 'kind' | 'qa'>): Exclude<SourceGroup, 'all'> {
  if (source.kind === 'website' || source.kind === 'sitemap') return 'website'
  if (source.kind === 'learning' || source.qa) return 'qa'
  return 'document'
}

/** Sources in a type group matching a search over title and address. */
export function filterSources<T extends Pick<KnowledgeSourceView, 'kind' | 'qa' | 'title' | 'url'>>(sources: readonly T[], group: SourceGroup, query: string): T[] {
  const q = query.trim().toLowerCase()
  return sources.filter((s) => (group === 'all' || sourceGroup(s) === group) && (!q || `${s.title} ${s.url ?? ''}`.toLowerCase().includes(q)))
}

/** Crawl progress (0..100) of a running website or sitemap source, or null. */
export function syncProgress(source: Pick<KnowledgeSourceView, 'kind' | 'status' | 'pages_indexed' | 'page_limit'>): number | null {
  if (!isRunning(source) || !isCrawled(source.kind) || source.page_limit <= 0) return null
  return Math.max(4, Math.min(99, Math.round((source.pages_indexed / source.page_limit) * 100)))
}

/** The kind label key of a source (Q&A text sources have their own). */
export const kindKey = (source: Pick<KnowledgeSourceView, 'kind' | 'qa'>): string => (source.qa ? 'qa' : source.kind)
