// Knowledge sources: websites, sitemaps, uploaded files and typed text that
// feed the AI knowledge base, plus the durable worker job 'ai.crawl_source'
// that fetches and indexes them.
//
// Adding, re-crawling or deleting a source is admin-only and runs inside
// withTenant; the crawl job is inserted in the same transaction as the source
// change, so it is durable before the request is acknowledged. A source is
// claimed for a run atomically (status queued), so two runs never start for
// it at once; a run that has made no progress for 30 minutes may be restarted.
// Each run has an id stored on the source (current_run_id); a job whose runId
// is not the current one changes nothing, so a run replaced by a restart stops
// at its next check instead of racing the new one.
//
// The job works in slices of about 40 seconds and queues its own
// continuation (state in the job payload), so a 500-page crawl never holds
// the worker's queue. Each page is upserted on (source, url); a page whose
// text hash is unchanged is only touched, a changed one is re-chunked and
// re-embedded, and after a complete run the pages not seen again are
// deleted, except pages whose fetch failed transiently (timeout, network,
// 5xx, 429); when too many fetches failed, or a robots.txt or sitemap fetch
// did, nothing is deleted and the source reports 'crawl_partial'. A file,
// text or learned source is re-indexed in id order with the same slices.
// A run that keeps failing is marked 'crawl_failed' on its last attempt.
// Without an embeddings key nothing is fetched and the source is marked
// failed with a reason code. Fetched text, titles and URLs are never logged.
//
// Access (Phase 13): each source says who may see it (min_role: 'agent' =
// agents and above, 'admin' = admins only) and whether it may ground
// customer-facing text (customer_facing). An admin-only source never grounds
// customer text (CHECK in SQL, refused here first). Choosing access other
// than the default needs admin plus the 'ai.knowledge' permission (checked by
// the routes) and is audited. Below admin, an admin-only source is left out of
// the list and its pages (the document policy hides its documents too).
//
// Question-and-answer sources (qa): a 'text' source whose title is the
// question and whose one document holds the question and its answer
// (qaDocument). Text and Q&A sources can be edited (updateSourceContent):
// the document is replaced and re-indexed by a new run in the same
// transaction, so the change is durable before the request is acknowledged.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AccountRole } from '@/lib/auth/roles'
import { hasMinRole } from '@/lib/auth/roles'
import { createAdminClient } from '@/lib/data/admin'
import type { DataClient } from '@/lib/data/types'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant'
import { loadEmbeddingsKey } from './config'
import { checkCrawlUrl, contentHash, defaultFetcher, initCrawl, parseCrawlState, runCrawlSlice, shortHash,
  type CrawlDeps, type CrawlFetcher, type CrawlState, type PageOutcome } from './crawler'
import { ingestDocument } from './knowledge'

export const AI_CRAWL_JOB = 'ai.crawl_source'
export const MAX_SOURCES_PER_ACCOUNT = 50
export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 500
export const TEXT_SOURCE_MAX_CHARS = 100_000
export const QA_QUESTION_MAX = 300
export const QA_ANSWER_MAX = 4000
/** Characters of a file source's stored text returned by getSource (a text source is returned whole, up to TEXT_SOURCE_MAX_CHARS, so it can be edited). */
export const CONTENT_PREVIEW_CHARS = 20_000
export const SOURCE_TITLE_MAX = 300
/** A run with no progress for this long is considered dead and may be restarted. */
export const STALE_RUN_MS = 30 * 60 * 1000
export const SLICE_BUDGET_MS = 40_000
/** Documents read per query when re-indexing a file, text or learned source. */
export const REINDEX_BATCH = 25
/** Transiently failed page URLs remembered per run (16-character hashes). */
export const MAX_FETCH_FAILURES = 2000

export type SourceKind = 'website' | 'sitemap' | 'file' | 'text' | 'learning'
export type SourceStatus = 'queued' | 'crawling' | 'ready' | 'failed' | 'disabled'
/** Stored in ai_knowledge_sources.error and translated by the UI; never page text. */
export type SourceErrorCode =
  | 'embeddings_key_missing' | 'embeddings_key_corrupt' | 'invalid_url' | 'blocked' | 'robots_disallowed'
  | 'robots_unreachable' | 'no_pages' | 'embedding_failed' | 'embedding_partial' | 'crawl_failed' | 'crawl_partial'

export type SourceMinRole = 'agent' | 'admin'

export interface SourceAccess {
  min_role: SourceMinRole
  customer_facing: boolean
}

export interface KnowledgeSource extends SourceAccess {
  id: string
  kind: SourceKind
  /** A 'text' source written as one question and its answer. */
  qa: boolean
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

export interface SourcePage { id: string; title: string; source_url: string | null; fetched_at: string | null }

/** The stored text of a file, text or Q&A source (preview), or its question and answer. */
export type SourceContent =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'qa'; question: string; answer: string }

/** The one document a Q&A source indexes: the question and its answer. */
export function qaDocument(question: string, answer: string): string {
  return `Question: ${question.trim()}\nAnswer: ${answer.trim()}`
}

/** At most `max` characters of a stored text, and whether it was cut. */
export const previewOf = (text: string, max: number): SourceContent => ({ kind: 'text', text: text.slice(0, max), truncated: text.length > max })

/** The question and answer of a stored Q&A document, or null when it is not one. */
export function parseQaDocument(content: string): { question: string; answer: string } | null {
  const match = /^Question: ([\s\S]*?)\nAnswer: ([\s\S]*)$/.exec(content)
  return match ? { question: match[1].trim(), answer: match[2].trim() } : null
}

export type KnowledgeSourceErrorCode = 'forbidden' | 'invalid_input' | 'invalid_url' | 'not_found' | 'busy' | 'limit_reached'
const STATUS: Record<KnowledgeSourceErrorCode, number> = {
  forbidden: 403, invalid_input: 400, invalid_url: 400, not_found: 404, busy: 409, limit_reached: 409,
}
export class KnowledgeSourceError extends Error {
  readonly status: number
  constructor(readonly code: KnowledgeSourceErrorCode) {
    super(`Knowledge source request refused: ${code}`)
    this.name = 'KnowledgeSourceError'
    this.status = STATUS[code]
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const title = z.string().trim().min(1).max(SOURCE_TITLE_MAX)
const minRole = z.enum(['agent', 'admin'])
export const sourceInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['website', 'sitemap']),
    url: z.string().trim().min(1).max(2048),
    title: title.optional(),
    page_limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
    min_role: minRole.optional(),
    customer_facing: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('text'),
    title,
    content: z.string().trim().min(1).max(TEXT_SOURCE_MAX_CHARS),
    min_role: minRole.optional(),
    customer_facing: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('qa'),
    question: z.string().trim().min(1).max(QA_QUESTION_MAX),
    answer: z.string().trim().min(1).max(QA_ANSWER_MAX),
    min_role: minRole.optional(),
    customer_facing: z.boolean().optional(),
  }).strict(),
])
export type SourceInput = z.infer<typeof sourceInputSchema>

/** The pairing rule: an admin-only source can never ground customer-facing text. */
export const validAccess = (a: SourceAccess): boolean => !a.customer_facing || a.min_role === 'agent'

/**
 * The access a new source gets: agents and above, used in customer replies,
 * unless given. Choosing 'admin' alone also turns customer use off. Throws
 * invalid_input for an admin-only source used in customer replies.
 */
export function resolveAccess(input: Partial<SourceAccess>): SourceAccess {
  const min_role = input.min_role ?? 'agent'
  const access: SourceAccess = { min_role, customer_facing: input.customer_facing ?? min_role === 'agent' }
  if (!validAccess(access)) throw new KnowledgeSourceError('invalid_input')
  return access
}

/** True when the input chooses access explicitly (the routes then require 'ai.knowledge'). */
export const setsAccess = (input: Partial<SourceAccess>): boolean => input.min_role !== undefined || input.customer_facing !== undefined

const accessSchema = z.object({ min_role: minRole.optional(), customer_facing: z.boolean().optional() }).strict()

/** A PATCH body: at least one of min_role, customer_facing. Throws invalid_input. */
export function parseAccessPatch(body: unknown): Partial<SourceAccess> {
  const parsed = accessSchema.safeParse(body)
  if (!parsed.success || !setsAccess(parsed.data)) throw new KnowledgeSourceError('invalid_input')
  return parsed.data
}

export function parseSourceInput(body: unknown): SourceInput {
  const parsed = sourceInputSchema.safeParse(body)
  if (!parsed.success) throw new KnowledgeSourceError('invalid_input')
  resolveAccess(parsed.data)
  if (parsed.data.kind === 'website' || parsed.data.kind === 'sitemap') {
    const raw = /^https?:\/\//i.test(parsed.data.url) ? parsed.data.url : `https://${parsed.data.url}`
    const checked = checkCrawlUrl(raw)
    if (!checked.ok) throw new KnowledgeSourceError('invalid_url')
    checked.url.hash = ''
    return { ...parsed.data, url: checked.url.toString() }
  }
  return parsed.data
}

function assertRole(ctx: TenantContext, min: AccountRole): void {
  if (!ctx.role || !hasMinRole(ctx.role, min)) throw new KnowledgeSourceError('forbidden')
}

const SOURCE_COLUMNS = 'id::text, kind, qa, url, title, status, page_limit, pages_indexed, last_crawled_at, error, min_role, customer_facing, created_by::text, current_run_id::text, created_at, updated_at'
type SourceRow = Omit<KnowledgeSource, 'last_crawled_at' | 'created_at' | 'updated_at'> &
  { last_crawled_at: Date | null; created_at: Date; updated_at: Date; created_by: string | null; current_run_id: string | null }
const toSource = (r: SourceRow): KnowledgeSource => ({
  id: r.id, kind: r.kind, qa: r.qa === true, url: r.url, title: r.title, status: r.status, page_limit: r.page_limit,
  pages_indexed: r.pages_indexed, error: r.error,
  // Rows read before the Phase 13 columns existed (or a mocked row) keep the defaults.
  min_role: r.min_role === 'admin' ? 'admin' : 'agent', customer_facing: r.customer_facing !== false,
  last_crawled_at: r.last_crawled_at ? r.last_crawled_at.toISOString() : null,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
})

async function selectSource(tx: TenantTransaction, accountId: string, id: string, lock = false): Promise<SourceRow | null> {
  const rows = lock
    ? await tx.$queryRawUnsafe<SourceRow[]>(`SELECT ${SOURCE_COLUMNS} FROM ai_knowledge_sources WHERE account_id=$1::uuid AND id=$2::uuid FOR UPDATE`, accountId, id)
    : await tx.$queryRawUnsafe<SourceRow[]>(`SELECT ${SOURCE_COLUMNS} FROM ai_knowledge_sources WHERE account_id=$1::uuid AND id=$2::uuid`, accountId, id)
  return rows[0] ?? null
}

/** Inserts the crawl job in the caller's transaction (app role for a request, worker role for a continuation). */
export async function queueCrawlJob(tx: TenantTransaction, accountId: string, payload: Record<string, unknown> & { sourceId: string; runId: string },
  step = 0, runAt: Date = new Date()): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
    VALUES(${AI_CRAWL_JOB},${accountId}::uuid,${JSON.stringify(payload)}::jsonb,${`ai-crawl:${payload.sourceId}:${payload.runId}:${step}`},${runAt},3)
    ON CONFLICT(dedupe_key) DO NOTHING`
}

/** Below admin, admin-only sources are not shown at all. */
const seesAdminSources = (ctx: TenantContext): boolean => !!ctx.role && hasMinRole(ctx.role, 'admin')

export async function listSources(ctx: TenantContext): Promise<KnowledgeSource[]> {
  assertRole(ctx, 'viewer')
  const filter = seesAdminSources(ctx) ? '' : ` AND min_role = 'agent'`
  return withTenant(ctx, async (tx) => (await tx.$queryRawUnsafe<SourceRow[]>(
    `SELECT ${SOURCE_COLUMNS} FROM ai_knowledge_sources WHERE account_id=$1::uuid${filter} ORDER BY created_at DESC LIMIT 200`, ctx.accountId,
  )).map(toSource))
}

export async function getSource(ctx: TenantContext, id: string): Promise<{ source: KnowledgeSource; pages: SourcePage[]; content: SourceContent | null } | null> {
  assertRole(ctx, 'viewer')
  if (!UUID.test(id)) return null
  return withTenant(ctx, async (tx) => {
    const row = await selectSource(tx, ctx.accountId, id)
    if (!row || (row.min_role === 'admin' && !seesAdminSources(ctx))) return null
    const pages = await tx.$queryRaw<{ id: string; title: string; source_url: string | null; fetched_at: Date | null }[]>`
      SELECT id::text, title, source_url, fetched_at FROM ai_knowledge_documents
      WHERE account_id=${ctx.accountId}::uuid AND source_id=${id}::uuid ORDER BY source_url NULLS FIRST, title LIMIT 500`
    // A file, text or Q&A source shows its stored text (a website lists its pages instead).
    let content: SourceContent | null = null
    if (row.kind === 'file' || row.kind === 'text') {
      const [doc] = await tx.$queryRaw<{ content: string }[]>`
        SELECT content FROM ai_knowledge_documents WHERE account_id=${ctx.accountId}::uuid AND source_id=${id}::uuid
        ORDER BY created_at LIMIT 1`
      const qa = row.qa && doc ? parseQaDocument(doc.content) : null
      content = qa ? { kind: 'qa', ...qa }
        : doc ? previewOf(doc.content, row.kind === 'text' ? TEXT_SOURCE_MAX_CHARS : CONTENT_PREVIEW_CHARS)
        : null
    }
    return {
      source: toSource(row),
      pages: pages.map((p) => ({ ...p, fetched_at: p.fetched_at ? p.fetched_at.toISOString() : null })),
      content,
    }
  })
}

async function assertRoom(tx: TenantTransaction, accountId: string): Promise<void> {
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ai_knowledge_sources WHERE account_id=${accountId}::uuid AND kind <> 'learning'`
  if (n >= MAX_SOURCES_PER_ACCOUNT) throw new KnowledgeSourceError('limit_reached')
}

/** Adds a website, sitemap or text source and queues its first run (admin). */
export async function createSource(ctx: TenantContext, input: SourceInput): Promise<KnowledgeSource> {
  assertRole(ctx, 'admin')
  return withTenant(ctx, async (tx) => {
    await assertRoom(tx, ctx.accountId)
    const runId = randomUUID()
    let row: SourceRow
    const access = resolveAccess(input)
    if (input.kind === 'text') {
      row = await insertSourceWithDocument(tx, ctx, 'text', input.title, input.content, runId, access)
    } else if (input.kind === 'qa') {
      row = await insertSourceWithDocument(tx, ctx, 'text', input.question, qaDocument(input.question, input.answer), runId, access, true)
    } else {
      const name = input.title ?? new URL(input.url).hostname
      row = (await tx.$queryRawUnsafe<SourceRow[]>(
        `INSERT INTO ai_knowledge_sources(account_id, kind, url, title, status, page_limit, created_by, current_run_id, min_role, customer_facing)
         VALUES ($1::uuid, $2, $3, $4, 'queued', $5, $6::uuid, $7::uuid, $8, $9) RETURNING ${SOURCE_COLUMNS}`,
        ctx.accountId, input.kind, input.url, name.slice(0, SOURCE_TITLE_MAX), input.page_limit ?? DEFAULT_PAGE_LIMIT, ctx.userId ?? null, runId,
        access.min_role, access.customer_facing,
      ))[0]
    }
    if (setsAccess(input)) await auditAccess(tx, ctx, row.id, access)
    await queueCrawlJob(tx, ctx.accountId, { sourceId: row.id, runId })
    return toSource(row)
  })
}

/** Adds an uploaded file's extracted text as a source and queues its indexing (admin). */
export async function createFileSource(ctx: TenantContext, input: { title: string; text: string }): Promise<KnowledgeSource> {
  assertRole(ctx, 'admin')
  const name = input.title.replace(/\s+/g, ' ').trim().slice(0, SOURCE_TITLE_MAX)
  if (!name || !input.text.trim()) throw new KnowledgeSourceError('invalid_input')
  return withTenant(ctx, async (tx) => {
    await assertRoom(tx, ctx.accountId)
    const runId = randomUUID()
    const row = await insertSourceWithDocument(tx, ctx, 'file', name, input.text, runId)
    await queueCrawlJob(tx, ctx.accountId, { sourceId: row.id, runId })
    return toSource(row)
  })
}

async function insertSourceWithDocument(tx: TenantTransaction, ctx: TenantContext, kind: 'text' | 'file', name: string, content: string,
  runId: string, access: SourceAccess = resolveAccess({}), qa = false): Promise<SourceRow> {
  const row = (await tx.$queryRawUnsafe<SourceRow[]>(
    `INSERT INTO ai_knowledge_sources(account_id, kind, title, status, created_by, current_run_id, min_role, customer_facing, qa)
     VALUES ($1::uuid, $2, $3, 'queued', $4::uuid, $5::uuid, $6, $7, $8) RETURNING ${SOURCE_COLUMNS}`,
    ctx.accountId, kind, name.slice(0, SOURCE_TITLE_MAX), ctx.userId ?? null, runId, access.min_role, access.customer_facing, qa,
  ))[0]
  // content_hash is set only once the document is indexed.
  await tx.$executeRaw`INSERT INTO ai_knowledge_documents(account_id, created_by, title, content, source_id, fetched_at)
    VALUES (${ctx.accountId}::uuid, ${ctx.userId ?? null}::uuid, ${name}, ${content}, ${row.id}::uuid, now())`
  return row
}

const auditAccess = (tx: TenantTransaction, ctx: TenantContext, sourceId: string, access: SourceAccess) => tx.$executeRaw`
  INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
  VALUES (${ctx.accountId}::uuid, ${ctx.userId ?? null}::uuid, 'ai.knowledge_access_updated', ${sourceId}, ${JSON.stringify(access)}::jsonb)`

/**
 * Changes who may see a source and whether it grounds customer replies
 * (admin; the route also requires 'ai.knowledge'). A field left out keeps its
 * value, except that making a source admin-only also turns customer use off.
 * The pair must stay valid (invalid_input otherwise). Audited when changed.
 */
export async function updateSourceAccess(ctx: TenantContext, id: string, patch: Partial<SourceAccess>): Promise<KnowledgeSource> {
  assertRole(ctx, 'admin')
  if (!UUID.test(id)) throw new KnowledgeSourceError('not_found')
  return withTenant(ctx, async (tx) => {
    const current = await selectSource(tx, ctx.accountId, id, true)
    if (!current) throw new KnowledgeSourceError('not_found')
    const before = toSource(current)
    const next: SourceAccess = {
      min_role: patch.min_role ?? before.min_role,
      customer_facing: patch.customer_facing ?? (patch.min_role === 'admin' ? false : before.customer_facing),
    }
    if (!validAccess(next)) throw new KnowledgeSourceError('invalid_input')
    if (next.min_role === before.min_role && next.customer_facing === before.customer_facing) return before
    const row = (await tx.$queryRawUnsafe<SourceRow[]>(
      `UPDATE ai_knowledge_sources SET min_role=$3, customer_facing=$4 WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${SOURCE_COLUMNS}`,
      ctx.accountId, id, next.min_role, next.customer_facing,
    ))[0]
    await auditAccess(tx, ctx, id, next)
    return toSource(row)
  })
}

const contentSchema = z.union([
  z.object({ question: z.string().trim().min(1).max(QA_QUESTION_MAX), answer: z.string().trim().min(1).max(QA_ANSWER_MAX) }).strict(),
  z.object({ title, content: z.string().trim().min(1).max(TEXT_SOURCE_MAX_CHARS) }).strict(),
])
export type SourceContentInput = z.infer<typeof contentSchema>

/** A content edit body: { question, answer } for a Q&A source, { title, content } for a text source. Throws invalid_input. */
export function parseContentInput(body: unknown): SourceContentInput {
  const parsed = contentSchema.safeParse(body)
  if (!parsed.success) throw new KnowledgeSourceError('invalid_input')
  return parsed.data
}

/**
 * Replaces the text of a text or Q&A source and queues its re-indexing in the
 * same transaction (admin). A run in progress is superseded by the new one.
 * Websites, sitemaps, files and learned answers are not edited here (invalid_input).
 */
export async function updateSourceContent(ctx: TenantContext, id: string, input: SourceContentInput): Promise<KnowledgeSource> {
  assertRole(ctx, 'admin')
  if (!UUID.test(id)) throw new KnowledgeSourceError('not_found')
  return withTenant(ctx, async (tx) => {
    const current = await selectSource(tx, ctx.accountId, id, true)
    if (!current) throw new KnowledgeSourceError('not_found')
    const isQa = 'question' in input
    if (current.kind !== 'text' || current.qa !== isQa) throw new KnowledgeSourceError('invalid_input')
    const name = (isQa ? input.question : input.title).slice(0, SOURCE_TITLE_MAX)
    const text = isQa ? qaDocument(input.question, input.answer) : input.content
    await tx.$executeRaw`UPDATE ai_knowledge_sources SET title=${name} WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`
    // One document per text source: replace it (chunks cascade), then re-index from it.
    await tx.$executeRaw`DELETE FROM ai_knowledge_documents WHERE account_id=${ctx.accountId}::uuid AND source_id=${id}::uuid`
    await tx.$executeRaw`INSERT INTO ai_knowledge_documents(account_id, created_by, title, content, source_id, fetched_at)
      VALUES (${ctx.accountId}::uuid, ${ctx.userId ?? null}::uuid, ${name}, ${text}, ${id}::uuid, now())`
    await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES (${ctx.accountId}::uuid, ${ctx.userId ?? null}::uuid, 'ai.knowledge_content_updated', ${id}, ${JSON.stringify({ qa: isQa })}::jsonb)`
    return toSource(await startRun(tx, ctx.accountId, id))
  })
}

/** Deletes a source; its documents and chunks cascade. A queued run finds nothing and stops (admin). */
export async function deleteSource(ctx: TenantContext, id: string): Promise<boolean> {
  assertRole(ctx, 'admin')
  if (!UUID.test(id)) return false
  return withTenant(ctx, async (tx) => (await tx.$executeRaw`
    DELETE FROM ai_knowledge_sources WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`) > 0)
}

/** Re-crawls a website or sitemap, or re-indexes a file, text or learned source (admin). */
export async function recrawlSource(ctx: TenantContext, id: string, now: number = Date.now()): Promise<KnowledgeSource> {
  assertRole(ctx, 'admin')
  if (!UUID.test(id)) throw new KnowledgeSourceError('not_found')
  return withTenant(ctx, async (tx) => {
    const current = await selectSource(tx, ctx.accountId, id, true)
    if (!current) throw new KnowledgeSourceError('not_found')
    const running = current.status === 'queued' || current.status === 'crawling'
    if (running && now - current.updated_at.getTime() < STALE_RUN_MS) throw new KnowledgeSourceError('busy')
    return toSource(await startRun(tx, ctx.accountId, id))
  })
}

/** Claims the (locked) source for a new run and queues its first job; the previous run, if any, stops at its next check. */
async function startRun(tx: TenantTransaction, accountId: string, id: string): Promise<SourceRow> {
  const runId = randomUUID()
  const row = (await tx.$queryRawUnsafe<SourceRow[]>(
    `UPDATE ai_knowledge_sources SET status='queued', error=NULL, current_run_id=$3::uuid
     WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${SOURCE_COLUMNS}`,
    accountId, id, runId,
  ))[0]
  await queueCrawlJob(tx, accountId, { sourceId: id, runId })
  return row
}

/**
 * Re-crawls or re-indexes every source that is not already running (a run
 * stale for STALE_RUN_MS counts as not running), in one transaction with
 * their jobs (admin). Returns how many runs were queued.
 */
export async function queueReindexAllSources(ctx: TenantContext, now: number = Date.now()): Promise<number> {
  assertRole(ctx, 'admin')
  return withTenant(ctx, async (tx) => {
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM ai_knowledge_sources WHERE account_id=${ctx.accountId}::uuid
        AND (status NOT IN ('queued','crawling') OR updated_at < ${new Date(now - STALE_RUN_MS)})
      ORDER BY created_at FOR UPDATE`
    for (const { id } of ids) await startRun(tx, ctx.accountId, id)
    return ids.length
  })
}

// ================================================================ worker job

interface JobDeps extends CrawlDeps {
  prisma?: Parameters<typeof withTenant>[2]
  db?: DataClient
  embeddingsKey?: { key: string | null; corrupt: boolean }
  ingest?: typeof ingestDocument
  budgetMs?: number
}

type Tenant = <T>(work: (tx: TenantTransaction) => Promise<T>) => Promise<T>

/** The source was claimed by a newer run, finished or deleted: this job ends without changing anything. */
class SupersededRunError extends Error {
  constructor() { super('Knowledge source run superseded'); this.name = 'SupersededRunError' }
}
/** A payload or state that no retry can fix. */
class InvalidRunStateError extends Error {
  constructor() { super('Invalid crawl job state'); this.name = 'InvalidRunStateError' }
}

/** Transient fetch failures of this run: page URL hashes, and whether a robots.txt or sitemap fetch failed. */
interface FetchFailures { pages: string[]; structural: boolean }
interface ReindexProgress { after: string | null; done: number; failures: number }
interface ContinuationPayload {
  sourceId: string; runId: string; step: number
  // website / sitemap
  startedAt?: string; state?: CrawlState; failures?: FetchFailures
  // file / text / learning
  reindex?: ReindexProgress
}

interface Run {
  accountId: string; sourceId: string; runId: string; step: number
  source: SourceRow; db: DataClient; ingest: typeof ingestDocument; tenant: Tenant; deps: JobDeps
}

/** Locks the source row (shared) for the rest of the transaction and checks this run still owns it. */
async function assertCurrent(tx: TenantTransaction, run: Run): Promise<void> {
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM ai_knowledge_sources WHERE account_id=${run.accountId}::uuid AND id=${run.sourceId}::uuid
      AND current_run_id=${run.runId}::uuid AND status IN ('queued','crawling') FOR SHARE`
  if (rows.length === 0) throw new SupersededRunError()
}

async function setStatus(run: Run, status: SourceStatus, error: SourceErrorCode | null, finished: boolean, tx?: TenantTransaction): Promise<void> {
  const write = (t: TenantTransaction) => t.$executeRaw`
    UPDATE ai_knowledge_sources SET status=${status}, error=${error},
      pages_indexed=(SELECT count(*)::int FROM ai_knowledge_documents WHERE account_id=${run.accountId}::uuid AND source_id=${run.sourceId}::uuid),
      last_crawled_at=CASE WHEN ${finished} THEN now() ELSE last_crawled_at END
    WHERE account_id=${run.accountId}::uuid AND id=${run.sourceId}::uuid
      AND current_run_id=${run.runId}::uuid AND status IN ('queued','crawling')`
  const changed = tx ? await write(tx) : await run.tenant(write)
  if (changed === 0) throw new SupersededRunError()
}

/** Marks the run alive and queues its next slice, only while it still owns the source. */
async function continueRun(run: Run, next: ContinuationPayload, kept: number): Promise<void> {
  await run.tenant(async (tx) => {
    const changed = await tx.$executeRaw`UPDATE ai_knowledge_sources SET status='crawling', pages_indexed=GREATEST(pages_indexed, ${kept})
      WHERE account_id=${run.accountId}::uuid AND id=${run.sourceId}::uuid
        AND current_run_id=${run.runId}::uuid AND status IN ('queued','crawling')`
    if (changed === 0) throw new SupersededRunError()
    await queueCrawlJob(tx, run.accountId, next as unknown as Record<string, unknown> & { sourceId: string; runId: string },
      next.step, new Date(Date.now() + 1000))
  })
}

/** True when the queue will not retry this job: the attempt running now is its last. */
async function isLastAttempt(run: Run): Promise<boolean> {
  try {
    const rows = await run.tenant((tx) => tx.$queryRaw<{ attempts: number; max_attempts: number }[]>`
      SELECT attempts, max_attempts FROM jobs WHERE type=${AI_CRAWL_JOB}
        AND dedupe_key=${`ai-crawl:${run.sourceId}:${run.runId}:${run.step}`}`)
    return rows.length > 0 && rows[0].attempts >= rows[0].max_attempts
  } catch {
    return false
  }
}

/**
 * Worker handler for 'ai.crawl_source'. Payload { sourceId, runId } starts a
 * run; a continuation also carries { step } and either { startedAt, state,
 * failures } (website, sitemap) or { reindex } (file, text, learning). Only
 * the source's current run does anything.
 */
export async function handleCrawlSourceJob(accountId: string, payload: Record<string, unknown>, deps: JobDeps = {}): Promise<void> {
  if (!UUID.test(String(payload.sourceId)) || typeof payload.runId !== 'string' || !UUID.test(payload.runId)) {
    throw new Error('Invalid crawl job payload')
  }
  const sourceId = String(payload.sourceId)
  const runId = payload.runId
  const step = payload.step === undefined ? 0 : payload.step
  const ctx: TenantContext = { accountId, role: 'owner' }
  const prisma = deps.prisma ?? getWorkerPrisma()
  const tenant: Tenant = (work) => withTenant(ctx, work, prisma)

  const source = await tenant((tx) => selectSource(tx, accountId, sourceId))
  if (!source || (source.status !== 'queued' && source.status !== 'crawling') || source.current_run_id !== runId) return

  const run: Run = {
    accountId, sourceId, runId, step: Number.isInteger(step) ? (step as number) : 0, source, tenant, deps,
    db: deps.db ?? createAdminClient(ctx), ingest: deps.ingest ?? ingestDocument,
  }
  try {
    if (!Number.isInteger(step) || (step as number) < 0) throw new InvalidRunStateError()
    const { key, corrupt } = deps.embeddingsKey ?? await loadEmbeddingsKey(run.db, accountId)
    if (!key) {
      await setStatus(run, 'failed', corrupt ? 'embeddings_key_corrupt' : 'embeddings_key_missing', true)
      return
    }
    if (source.kind === 'website' || source.kind === 'sitemap') await crawlWebsite(run, payload, key)
    else await reindexStoredDocuments(run, payload, key)
  } catch (err) {
    if (err instanceof SupersededRunError) return
    // A run the queue will not retry would otherwise spin as 'crawling' forever.
    if (err instanceof InvalidRunStateError || await isLastAttempt(run)) {
      await setStatus(run, 'failed', 'crawl_failed', true).catch(() => undefined)
    }
    throw err
  }
}

function isTransientFailure(res: Awaited<ReturnType<CrawlFetcher>>): boolean {
  return res.ok ? res.status >= 500 || res.status === 429 : res.error === 'timeout' || res.error === 'network'
}

function parseFetchFailures(value: unknown): FetchFailures | null {
  if (value === undefined) return { pages: [], structural: false }
  const f = value as FetchFailures | null
  if (!f || typeof f !== 'object' || typeof f.structural !== 'boolean' || !Array.isArray(f.pages)
    || f.pages.length > MAX_FETCH_FAILURES || !f.pages.every((p) => typeof p === 'string' && /^[0-9a-f]{16}$/.test(p))) return null
  return { pages: f.pages, structural: f.structural }
}

async function crawlWebsite(run: Run, payload: Record<string, unknown>, key: string): Promise<void> {
  const { accountId, sourceId, runId, source, deps, tenant } = run
  let state: CrawlState
  let startedAt: string
  let failures: FetchFailures
  if (payload.state !== undefined) {
    const parsed = parseCrawlState(payload.state)
    const carried = parseFetchFailures(payload.failures)
    if (!parsed || !carried || typeof payload.startedAt !== 'string' || Number.isNaN(Date.parse(payload.startedAt))) throw new InvalidRunStateError()
    state = parsed
    failures = carried
    startedAt = payload.startedAt
  } else {
    const init = initCrawl(source.kind as 'website' | 'sitemap', source.url ?? '')
    if ('error' in init) { await setStatus(run, 'failed', init.error, true); return }
    state = init.state
    failures = { pages: [], structural: false }
    await setStatus(run, 'crawling', null, false)
    // The database clock, which also stamps fetched_at, so worker clock skew cannot delete fresh pages.
    startedAt = (await tenant((tx) => tx.$queryRaw<{ t: Date }[]>`SELECT now() AS t`))[0].t.toISOString()
  }

  // Remember transient failures so a partial outage does not delete the pages it hid.
  const failedPages = new Set(failures.pages)
  const baseFetcher = deps.fetcher ?? defaultFetcher
  const fetcher: CrawlFetcher = async (url, opts) => {
    const res = await baseFetcher(url, opts)
    if (isTransientFailure(res)) {
      if (opts.accept.startsWith('text/html') && failedPages.size < MAX_FETCH_FAILURES) failedPages.add(shortHash(url))
      else failures.structural = true // robots.txt or a sitemap: whole sets of pages went unseen
    }
    return res
  }

  const onPage = async (page: { url: string; title: string; text: string; hash: string }): Promise<PageOutcome> => {
    const doc = await tenant(async (tx) => {
      await assertCurrent(tx, run)
      const existing = (await tx.$queryRaw<{ id: string; content_hash: string | null }[]>`
        SELECT id::text, content_hash FROM ai_knowledge_documents
        WHERE account_id=${accountId}::uuid AND source_id=${sourceId}::uuid AND source_url=${page.url}`)[0]
      if (existing?.content_hash === page.hash) {
        await tx.$executeRaw`UPDATE ai_knowledge_documents SET fetched_at=now() WHERE account_id=${accountId}::uuid AND id=${existing.id}::uuid`
        return null
      }
      return (await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ai_knowledge_documents(account_id, created_by, title, content, source_id, source_url, content_hash, fetched_at)
        VALUES (${accountId}::uuid, ${source.created_by ?? null}::uuid, ${page.title}, ${page.text}, ${sourceId}::uuid, ${page.url}, NULL, now())
        ON CONFLICT (account_id, source_id, source_url) DO UPDATE
          SET title=EXCLUDED.title, content=EXCLUDED.content, content_hash=NULL, fetched_at=now(), updated_at=now()
        RETURNING id::text`)[0]
    })
    if (!doc) return 'unchanged'
    return indexDocument(run, doc.id, page.text, page.hash, key)
  }

  const { done } = await runCrawlSlice(state, {
    pageLimit: source.page_limit,
    budgetMs: deps.budgetMs ?? SLICE_BUDGET_MS,
    onPage,
    fetcher, sleep: deps.sleep, now: deps.now, delayMs: deps.delayMs,
  })
  const carry: FetchFailures = { pages: [...failedPages], structural: failures.structural }

  if (!done) {
    await continueRun(run, { sourceId, runId, step: run.step + 1, startedAt, state, failures: carry }, state.kept)
    return
  }

  const origin = Object.keys(state.robots)[0]
  const robotsBlocked = state.kept === 0 && origin !== undefined
    && state.robots[origin].disallow.includes('/') && state.robots[origin].allow.length === 0
  if (state.kept === 0) {
    // Nothing fetched (site down, robots, empty pages): keep the pages from the last good run.
    await setStatus(run, 'failed', robotsBlocked ? 'robots_disallowed' : 'no_pages', true)
    return
  }
  // Too many fetches failed to trust "not seen again" as "gone": keep every page this time.
  const partial = carry.structural || carry.pages.length >= state.kept
  const error: SourceErrorCode | null = state.embedFailures >= state.kept ? 'embedding_failed'
    : partial ? 'crawl_partial' : state.embedFailures > 0 ? 'embedding_partial' : null
  await tenant(async (tx) => {
    await assertCurrent(tx, run)
    if (!partial) {
      await tx.$executeRaw`
        DELETE FROM ai_knowledge_documents WHERE account_id=${accountId}::uuid AND source_id=${sourceId}::uuid
          AND (fetched_at IS NULL OR fetched_at < ${new Date(startedAt)})
          AND (source_url IS NULL OR left(encode(sha256(convert_to(source_url, 'UTF8')), 'hex'), 16) <> ALL(${carry.pages}::text[]))`
    }
    await setStatus(run, error === 'embedding_failed' ? 'failed' : 'ready', error, true, tx)
  })
}

/** Chunks and embeds one document; its hash is recorded only on success, so a failed embed is retried next run. */
async function indexDocument(run: Run, documentId: string, text: string, hash: string, key: string): Promise<PageOutcome> {
  try {
    await run.ingest(run.db, run.accountId, { embeddingsApiKey: key }, documentId, text)
  } catch (err) {
    console.error('[ai crawl] indexing a page failed:', err instanceof Error ? err.name : 'unknown')
    return 'embed_failed'
  }
  await run.tenant((tx) => tx.$executeRaw`UPDATE ai_knowledge_documents SET content_hash=${hash}
    WHERE account_id=${run.accountId}::uuid AND id=${documentId}::uuid`)
  return 'stored'
}

function parseReindexProgress(value: unknown): ReindexProgress | null {
  const p = value as ReindexProgress | null
  if (!p || typeof p !== 'object' || (p.after !== null && (typeof p.after !== 'string' || !UUID.test(p.after)))) return null
  if (![p.done, p.failures].every((n) => Number.isInteger(n) && n >= 0) || p.failures > p.done) return null
  return { after: p.after, done: p.done, failures: p.failures }
}

/** Re-indexes every stored document of a file, text or learned source, in id order, in time-boxed slices. */
async function reindexStoredDocuments(run: Run, payload: Record<string, unknown>, key: string): Promise<void> {
  const { accountId, sourceId, runId, deps, tenant } = run
  let progress: ReindexProgress
  if (payload.reindex !== undefined) {
    const parsed = parseReindexProgress(payload.reindex)
    if (!parsed) throw new InvalidRunStateError()
    progress = parsed
  } else {
    progress = { after: null, done: 0, failures: 0 }
    await setStatus(run, 'crawling', null, false)
  }
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.budgetMs ?? SLICE_BUDGET_MS)
  for (;;) {
    const after = progress.after
    const docs = await tenant(async (tx) => {
      await assertCurrent(tx, run)
      return tx.$queryRaw<{ id: string; content: string }[]>`
        SELECT id::text, content FROM ai_knowledge_documents WHERE account_id=${accountId}::uuid AND source_id=${sourceId}::uuid
          AND (${after}::uuid IS NULL OR id > ${after}::uuid)
        ORDER BY id LIMIT ${REINDEX_BATCH}`
    })
    for (const doc of docs) {
      const outcome = await indexDocument(run, doc.id, doc.content, contentHash(doc.content), key)
      progress = { after: doc.id, done: progress.done + 1, failures: progress.failures + (outcome === 'embed_failed' ? 1 : 0) }
      if (now() >= deadline) {
        await continueRun(run, { sourceId, runId, step: run.step + 1, reindex: progress }, progress.done)
        return
      }
    }
    if (docs.length < REINDEX_BATCH) break
  }
  if (progress.done === 0) { await setStatus(run, 'failed', 'no_pages', true); return }
  const error: SourceErrorCode | null = progress.failures === 0 ? null
    : progress.failures >= progress.done ? 'embedding_failed' : 'embedding_partial'
  await setStatus(run, error === 'embedding_failed' ? 'failed' : 'ready', error, true)
}
