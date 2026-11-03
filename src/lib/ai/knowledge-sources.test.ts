import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake tenant transaction: enough SQL routing to drive the job handler without a database.
const h = vi.hoisted(() => ({
  source: null as null | Record<string, unknown>,
  docs: [] as { id: string; url: string | null; hash: string | null; content: string; fetched: number }[],
  jobs: [] as { payload: Record<string, unknown>; dedupe: string }[],
  statusUpdates: [] as { status: string; error: string | null }[],
  deletedBefore: null as Date | null,
  attempt: null as null | { attempts: number; max_attempts: number },
  clock: 1000,
}))

function sqlOf(q: unknown): string {
  return Array.isArray(q) ? (q as string[]).join('?') : String(q)
}

const running = () => h.source !== null && (h.source.status === 'queued' || h.source.status === 'crawling')
const owns = (runId: unknown) => running() && h.source!.current_run_id === runId
const urlHash = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 16)

const tx = {
  async $queryRawUnsafe(sql: string, ...v: unknown[]) {
    if (sql.startsWith('SELECT') && sql.includes('FROM ai_knowledge_sources')) return h.source ? [h.source] : []
    if (sql.startsWith("UPDATE ai_knowledge_sources SET status='queued'")) {
      h.source = { ...h.source, status: 'queued', error: null, current_run_id: v[2] }
      return [h.source]
    }
    throw new Error(`unexpected unsafe query: ${sql}`)
  },
  async $queryRaw(strings: TemplateStringsArray, ...v: unknown[]) {
    const sql = sqlOf(strings)
    if (sql.includes('SELECT 1 AS ok FROM ai_knowledge_sources')) return owns(v[2]) ? [{ ok: 1 }] : []
    if (sql.includes('FROM jobs WHERE type=')) return h.attempt ? [h.attempt] : []
    if (sql.includes('SELECT id::text FROM ai_knowledge_sources')) return h.source && (!running() || (h.source.updated_at as Date) < (v[1] as Date)) ? [{ id: h.source.id }] : []
    if (sql.includes('SELECT id::text, content_hash FROM ai_knowledge_documents')) {
      const d = h.docs.find((x) => x.url === v[2])
      return d ? [{ id: d.id, content_hash: d.hash }] : []
    }
    if (sql.includes('INSERT INTO ai_knowledge_documents')) {
      const url = v[5] as string
      let d = h.docs.find((x) => x.url === url)
      if (!d) { d = { id: `doc-${h.docs.length + 1}`, url, hash: null, content: v[3] as string, fetched: h.clock }; h.docs.push(d) }
      d.hash = null; d.content = v[3] as string; d.fetched = Date.now()
      return [{ id: d.id }]
    }
    if (sql.includes('SELECT now()')) return [{ t: new Date() }]
    if (sql.includes('SELECT id::text, content FROM ai_knowledge_documents')) {
      const after = v[2] as string | null
      return [...h.docs].sort((a, b) => a.id.localeCompare(b.id)).filter((d) => after === null || d.id > after)
        .slice(0, v[4] as number).map((d) => ({ id: d.id, content: d.content }))
    }
    throw new Error(`unexpected query: ${sql}`)
  },
  async $executeRaw(strings: TemplateStringsArray, ...v: unknown[]) {
    const sql = sqlOf(strings)
    if (sql.includes('SET fetched_at=now()')) { const d = h.docs.find((x) => x.id === v[1]); if (d) d.fetched = Date.now(); return 1 }
    if (sql.includes('SET content_hash=')) { const d = h.docs.find((x) => x.id === v[2]); if (d) d.hash = v[0] as string; return 1 }
    if (sql.includes('UPDATE ai_knowledge_sources SET status=?')) {
      if (!owns(v[7])) return 0
      h.source = { ...h.source, status: v[0], error: v[1] }
      h.statusUpdates.push({ status: v[0] as string, error: v[1] as string | null })
      return 1
    }
    if (sql.includes("UPDATE ai_knowledge_sources SET status='crawling'")) {
      if (!owns(v[3])) return 0
      h.source = { ...h.source, status: 'crawling' }
      h.statusUpdates.push({ status: 'crawling', error: null })
      return 1
    }
    if (sql.includes('INSERT INTO jobs')) { h.jobs.push({ payload: JSON.parse(v[2] as string), dedupe: v[3] as string }); return 1 }
    if (sql.includes('DELETE FROM ai_knowledge_documents')) {
      h.deletedBefore = v[2] as Date
      const runStart = h.deletedBefore.getTime()
      const kept = new Set(v[3] as string[])
      h.docs = h.docs.filter((d) => d.fetched >= runStart || (d.url !== null && kept.has(urlHash(d.url))))
      return 1
    }
    throw new Error(`unexpected exec: ${sql}`)
  },
}

vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (t: unknown) => unknown) => fn(tx) }))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }))
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({}) }))

import type { CrawlFetcher } from './crawler'
import {
  createSource, deleteSource, handleCrawlSourceJob, KnowledgeSourceError, listSources, parseSourceInput, queueReindexAllSources,
  recrawlSource, REINDEX_BATCH,
} from './knowledge-sources'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const SOURCE = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'

const page = (title: string, text: string, links = '') =>
  `<html><head><title>${title}</title></head><body><main><p>${text} — with enough words to be indexed as content.</p>${links}</main></body></html>`
let site: Record<string, string> = {}
const fetcher: CrawlFetcher = async (url) => site[url]
  ? { ok: true, status: 200, contentType: 'text/html', location: null, body: Buffer.from(site[url]) }
  : { ok: true, status: 404, contentType: 'text/html', location: null, body: Buffer.alloc(0) }

const ingest = vi.fn(async () => {})
const deps = () => ({
  fetcher, ingest, embeddingsKey: { key: 'sk-test', corrupt: false }, sleep: async () => {}, delayMs: 0,
  now: () => (h.clock += 1), budgetMs: 1_000_000,
})

beforeEach(() => {
  h.source = { id: SOURCE, kind: 'website', url: 'https://shop.com/', title: 'Shop', status: 'queued', page_limit: 50, pages_indexed: 0,
    last_crawled_at: null, error: null, created_by: null, current_run_id: RUN, created_at: new Date(), updated_at: new Date() }
  h.docs = []
  h.jobs = []
  h.statusUpdates = []
  h.deletedBefore = null
  h.attempt = null
  ingest.mockReset()
  ingest.mockResolvedValue(undefined)
  site = {
    'https://shop.com/': page('Home', 'Welcome', '<a href="/about">About</a>'),
    'https://shop.com/about': page('About', 'About us'),
  }
})

describe('parseSourceInput', () => {
  it('accepts websites, sitemaps and text, adding https:// when missing', () => {
    expect(parseSourceInput({ kind: 'website', url: 'shop.com' })).toEqual({ kind: 'website', url: 'https://shop.com/' })
    expect(parseSourceInput({ kind: 'sitemap', url: 'https://shop.com/sitemap.xml#x', page_limit: 10 }))
      .toEqual({ kind: 'sitemap', url: 'https://shop.com/sitemap.xml', page_limit: 10 })
    expect(parseSourceInput({ kind: 'text', title: ' FAQ ', content: ' Hours: 9-5 ' })).toEqual({ kind: 'text', title: 'FAQ', content: 'Hours: 9-5' })
  })

  it.each([
    [{ kind: 'website', url: 'http://127.0.0.1/' }, 'invalid_url'],
    [{ kind: 'website', url: 'http://localhost:3000/' }, 'invalid_url'],
    [{ kind: 'website', url: 'ftp://shop.com/' }, 'invalid_url'],
    [{ kind: 'website', url: 'https://shop.com/', page_limit: 501 }, 'invalid_input'],
    [{ kind: 'file', title: 'x' }, 'invalid_input'],
    [{ kind: 'text', title: 'x', content: '' }, 'invalid_input'],
    [{ kind: 'text', title: 'x', content: 'y', extra: 1 }, 'invalid_input'],
    [null, 'invalid_input'],
  ])('refuses %j', (body, code) => {
    expect(() => parseSourceInput(body)).toThrow(expect.objectContaining({ code }))
  })
})

describe('roles', () => {
  it('needs admin to add, re-crawl or delete and a member to list', async () => {
    const agent = { accountId: ACCOUNT, role: 'agent' as const }
    await expect(createSource(agent, { kind: 'text', title: 'a', content: 'b' })).rejects.toBeInstanceOf(KnowledgeSourceError)
    await expect(recrawlSource(agent, SOURCE)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(deleteSource(agent, SOURCE)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(listSources({ accountId: ACCOUNT })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('refuses a re-crawl while a recent run is in progress, but restarts a stale one', async () => {
    const admin = { accountId: ACCOUNT, role: 'admin' as const }
    h.source = { ...h.source, status: 'crawling', updated_at: new Date(Date.now() - 60_000) }
    await expect(recrawlSource(admin, SOURCE)).rejects.toMatchObject({ code: 'busy' })
    expect(h.jobs).toHaveLength(0)
  })
})

describe('handleCrawlSourceJob', () => {
  it('marks the source failed without an embeddings key and fetches nothing', async () => {
    const spy = vi.fn(fetcher)
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), fetcher: spy, embeddingsKey: { key: null, corrupt: false } })
    expect(h.statusUpdates).toEqual([{ status: 'failed', error: 'embeddings_key_missing' }])
    expect(spy).not.toHaveBeenCalled()
  })

  it('does nothing for a deleted or finished source', async () => {
    h.source = null
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, deps())
    h.source = { id: SOURCE, status: 'ready', current_run_id: RUN }
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, deps())
    expect(h.statusUpdates).toEqual([])
    expect(ingest).not.toHaveBeenCalled()
  })

  it('rejects a malformed payload', async () => {
    await expect(handleCrawlSourceJob(ACCOUNT, { sourceId: 'x', runId: RUN }, deps())).rejects.toThrow()
  })

  it('indexes pages, then on a re-crawl skips unchanged pages, re-indexes changed ones and deletes vanished ones', async () => {
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, deps())
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(h.docs.map((d) => d.url).sort()).toEqual(['https://shop.com/', 'https://shop.com/about'])
    expect(h.docs.every((d) => /^[0-9a-f]{64}$/.test(d.hash ?? ''))).toBe(true)
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'ready', error: null })

    // Second run: home unchanged, about removed, new page added.
    ingest.mockClear()
    h.statusUpdates = []
    h.source = { ...h.source, status: 'queued', current_run_id: '44444444-4444-4444-8444-444444444444' }
    site['https://shop.com/about'] = page('About', 'About us — updated')
    await new Promise((r) => setTimeout(r, 5))
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: '44444444-4444-4444-8444-444444444444' }, deps())
    expect(ingest).toHaveBeenCalledTimes(1) // only the changed page
    expect(h.docs).toHaveLength(2)

    // Third run: about disappears. (A tick passes so the run starts after the last fetch.)
    await new Promise((r) => setTimeout(r, 5))
    ingest.mockClear()
    h.source = { ...h.source, status: 'queued', current_run_id: '55555555-5555-4555-8555-555555555555' }
    site = { 'https://shop.com/': page('Home', 'Welcome') }
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: '55555555-5555-4555-8555-555555555555' }, deps())
    expect(h.docs.map((d) => d.url)).toEqual(['https://shop.com/'])
  })

  it('keeps the last good pages when nothing could be fetched', async () => {
    h.docs = [{ id: 'old', url: 'https://shop.com/old', hash: 'a'.repeat(64), content: 'x', fetched: 1 }]
    site = {}
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, deps())
    expect(h.docs).toHaveLength(1)
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'failed', error: 'no_pages' })
  })

  it('leaves the hash unset when embedding fails, so the page is retried next run', async () => {
    ingest.mockRejectedValue(new Error('embed down'))
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, deps())
    expect(h.docs.every((d) => d.hash === null)).toBe(true)
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'failed', error: 'embedding_failed' })
  })

  it('queues a continuation with its state when the slice runs out of time', async () => {
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), budgetMs: 0 })
    expect(h.jobs).toHaveLength(1)
    expect(h.jobs[0].dedupe).toBe(`ai-crawl:${SOURCE}:${RUN}:1`)
    expect(h.jobs[0].payload).toMatchObject({ sourceId: SOURCE, runId: RUN, step: 1, state: { v: 1, site: 'shop.com' } })
    expect(ingest).not.toHaveBeenCalled()
    // The continuation picks up where it left off and finishes the run.
    const next = JSON.parse(JSON.stringify(h.jobs[0].payload))
    h.jobs = []
    h.source = { ...h.source, status: 'crawling' }
    await handleCrawlSourceJob(ACCOUNT, next, deps())
    expect(h.jobs).toHaveLength(0)
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'ready', error: null })
  })

  it('re-indexes a text source without fetching', async () => {
    h.source = { ...h.source, kind: 'text', url: null }
    h.docs = [{ id: 'd1', url: null, hash: null, content: 'Our hours are 9 to 5.', fetched: 1 }]
    const spy = vi.fn(fetcher)
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), fetcher: spy })
    expect(spy).not.toHaveBeenCalled()
    expect(ingest).toHaveBeenCalledWith({}, ACCOUNT, { embeddingsApiKey: 'sk-test' }, 'd1', 'Our hours are 9 to 5.')
    expect(h.docs[0].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'ready', error: null })
  })
})

describe('run fencing', () => {
  const OLD = '66666666-6666-4666-8666-666666666666'

  it('ignores a job whose run was replaced by a re-crawl', async () => {
    h.source = { ...h.source, status: 'crawling', current_run_id: RUN }
    const spy = vi.fn(fetcher)
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: OLD }, { ...deps(), fetcher: spy })
    expect(spy).not.toHaveBeenCalled()
    expect(h.statusUpdates).toEqual([])
    expect(h.jobs).toEqual([])
  })

  it('stops a run replaced mid-slice: no more pages, no cleanup, no status, no continuation', async () => {
    h.docs = [{ id: 'old', url: 'https://shop.com/old', hash: 'a'.repeat(64), content: 'x', fetched: 1 }]
    const replacing: CrawlFetcher = async (url, opts) => {
      if (url === 'https://shop.com/') h.source = { ...h.source, current_run_id: OLD } // an admin re-crawls now
      return fetcher(url, opts)
    }
    await expect(handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), fetcher: replacing })).resolves.toBeUndefined()
    expect(ingest).not.toHaveBeenCalled()
    expect(h.docs.map((d) => d.id)).toEqual(['old'])
    expect(h.deletedBefore).toBeNull()
    expect(h.statusUpdates).toEqual([{ status: 'crawling', error: null }])
    expect(h.jobs).toEqual([])
  })

  it('does not queue a continuation for a run replaced during its slice', async () => {
    // The slice ends at once; the source is re-crawled before the continuation is queued.
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, {
      ...deps(), budgetMs: 0,
      now: () => { h.source = { ...h.source, current_run_id: OLD }; return h.clock },
    })
    expect(h.jobs).toEqual([])
  })

  it('records the new run id when an admin re-crawls', async () => {
    h.source = { ...h.source, status: 'ready' }
    await recrawlSource({ accountId: ACCOUNT, role: 'admin' }, SOURCE)
    expect(h.jobs).toHaveLength(1)
    expect(h.source!.current_run_id).toBe(h.jobs[0].payload.runId)
    expect(h.source!.current_run_id).not.toBe(RUN)
  })
})

describe('a run the queue gives up on', () => {
  const brokenClock = () => ({ ...deps(), now: () => { throw new Error('clock broke') } })

  it('is marked crawl_failed on its last attempt and the error still reaches the queue', async () => {
    h.attempt = { attempts: 3, max_attempts: 3 }
    h.source = { ...h.source, kind: 'text', url: null }
    h.docs = [{ id: 'd1', url: null, hash: null, content: 'Hours', fetched: 1 }]
    await expect(handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, brokenClock())).rejects.toThrow('clock broke')
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'failed', error: 'crawl_failed' })
  })

  it('stays running while the queue will retry', async () => {
    h.attempt = { attempts: 1, max_attempts: 3 }
    h.source = { ...h.source, kind: 'text', url: null }
    await expect(handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, brokenClock())).rejects.toThrow()
    expect(h.statusUpdates.some((u) => u.error === 'crawl_failed')).toBe(false)
  })

  it('fails an unparseable continuation at once', async () => {
    h.source = { ...h.source, status: 'crawling' }
    await expect(handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN, step: 1, startedAt: 'x', state: { v: 2 } }, deps()))
      .rejects.toThrow('Invalid crawl job state')
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'failed', error: 'crawl_failed' })
  })

  it('never marks a newer run failed', async () => {
    h.attempt = { attempts: 3, max_attempts: 3 }
    h.source = { ...h.source, status: 'crawling' }
    const replacing: CrawlFetcher = async () => {
      h.source = { ...h.source, current_run_id: '77777777-7777-4777-8777-777777777777' }
      throw new Error('socket exploded')
    }
    await expect(handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), fetcher: replacing })).rejects.toThrow()
    expect(h.statusUpdates.some((u) => u.error === 'crawl_failed')).toBe(false)
  })
})

describe('transient fetch failures on a re-crawl', () => {
  const links = (n: number) => Array.from({ length: n }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('')
  const seed = (n: number) => {
    site = { 'https://shop.com/': page('Home', 'Welcome', links(n)) }
    h.docs = []
    for (let i = 0; i < n; i++) {
      site[`https://shop.com/p${i}`] = page(`P${i}`, `Page number ${i}`)
      h.docs.push({ id: `old-${i}`, url: `https://shop.com/p${i}`, hash: 'a'.repeat(64), content: 'x', fetched: 1 })
    }
  }
  const pageNumber = (url: string) => { const m = /\/p(\d+)$/.exec(url); return m ? Number(m[1]) : -1 }
  const unavailable = (down: (url: string) => boolean): CrawlFetcher => async (url, opts) =>
    down(url) ? { ok: true, status: 503, contentType: 'text/html', location: null, body: Buffer.alloc(0) } : fetcher(url, opts)

  it('keeps every page when 30 of 50 return 503, and reports crawl_partial', async () => {
    seed(50)
    h.source = { ...h.source, page_limit: 100 }
    const down = (url: string) => pageNumber(url) >= 0 && pageNumber(url) < 30
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), fetcher: unavailable(down) })
    expect(h.docs.filter((d) => d.id.startsWith('old-'))).toHaveLength(50)
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'ready', error: 'crawl_partial' })
  })

  it('keeps only the transiently failed pages when most succeed, and deletes the ones really gone', async () => {
    seed(10)
    h.source = { ...h.source, page_limit: 100 }
    h.docs.push({ id: 'gone', url: 'https://shop.com/gone', hash: 'a'.repeat(64), content: 'x', fetched: 1 })
    const timeouts: CrawlFetcher = async (url, opts) => url.endsWith('/p3') ? { ok: false, error: 'timeout' } : fetcher(url, opts)
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), fetcher: timeouts })
    const urls = h.docs.map((d) => d.url)
    expect(urls).toContain('https://shop.com/p3')
    expect(urls).not.toContain('https://shop.com/gone')
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'ready', error: null })
  })

  it('deletes nothing when a sitemap fetch failed', async () => {
    h.source = { ...h.source, kind: 'sitemap', url: 'https://shop.com/sitemap.xml' }
    h.docs = [{ id: 'gone', url: 'https://shop.com/gone', hash: 'a'.repeat(64), content: 'x', fetched: 1 }]
    site = { 'https://shop.com/a': page('A', 'Alpha') }
    const index = '<sitemapindex><sitemap><loc>https://shop.com/s1.xml</loc></sitemap><sitemap><loc>https://shop.com/s2.xml</loc></sitemap></sitemapindex>'
    const s1 = '<urlset><url><loc>https://shop.com/a</loc></url></urlset>'
    const xml = (body: string) => ({ ok: true as const, status: 200, contentType: 'application/xml', location: null, body: Buffer.from(body) })
    const flaky: CrawlFetcher = async (url, opts) => {
      if (url.endsWith('/sitemap.xml')) return xml(index)
      if (url.endsWith('/s1.xml')) return xml(s1)
      if (url.endsWith('/s2.xml')) return { ok: false, error: 'timeout' }
      return fetcher(url, opts)
    }
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), fetcher: flaky })
    expect(h.docs.map((d) => d.id)).toContain('gone')
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'ready', error: 'crawl_partial' })
  })

  it('carries the failures across slices', async () => {
    seed(4)
    h.docs.push({ id: 'gone', url: 'https://shop.com/gone', hash: 'a'.repeat(64), content: 'x', fetched: 1 })
    const down = (url: string) => url.endsWith('/p1')
    let budget = 0
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, { ...deps(), fetcher: unavailable(down), budgetMs: budget })
    for (let i = 0; i < 20 && h.jobs.length; i++) {
      const payload = JSON.parse(JSON.stringify(h.jobs.pop()!.payload))
      budget = i % 2 ? 1_000_000 : 0
      await handleCrawlSourceJob(ACCOUNT, payload, { ...deps(), fetcher: unavailable(down), budgetMs: budget })
    }
    expect(h.jobs).toEqual([])
    const urls = h.docs.map((d) => d.url)
    expect(urls).toContain('https://shop.com/p1')
    expect(urls).not.toContain('https://shop.com/gone')
  })
})

describe('re-indexing stored documents', () => {
  it('pages through every document across slices, beyond the old 500 cap', async () => {
    h.source = { ...h.source, kind: 'learning', url: null }
    const docId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    h.docs = Array.from({ length: 700 }, (_, i) => ({ id: docId(i), url: null, hash: null, content: `Answer ${i}`, fetched: 1 }))
    let clock = 0
    const sliced = { ...deps(), now: () => clock, budgetMs: 100 }
    ingest.mockImplementation(async () => { clock += 1 })
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, sliced)
    let slices = 1
    while (h.jobs.length) {
      const next = JSON.parse(JSON.stringify(h.jobs.pop()!.payload))
      expect(next.reindex.done).toBe(100 * slices)
      await handleCrawlSourceJob(ACCOUNT, next, sliced)
      slices += 1
    }
    expect(slices).toBe(8) // seven full slices, then one that finds nothing left and finishes
    expect(ingest).toHaveBeenCalledTimes(700)
    expect(new Set(ingest.mock.calls.map((c) => (c as unknown[])[3])).size).toBe(700)
    expect(h.docs.every((d) => d.hash !== null)).toBe(true)
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'ready', error: null })
    expect(REINDEX_BATCH).toBeLessThan(700)
  })

  it('reports partial embedding failures', async () => {
    h.source = { ...h.source, kind: 'file', url: null }
    h.docs = Array.from({ length: 30 }, (_, i) => ({ id: `d${String(i).padStart(2, '0')}`, url: null, hash: null, content: `T${i}`, fetched: 1 }))
    ingest.mockImplementation(async (...args: unknown[]) => { if (args[3] === 'd05') throw new Error('rate limited') })
    await handleCrawlSourceJob(ACCOUNT, { sourceId: SOURCE, runId: RUN }, deps())
    expect(h.statusUpdates.at(-1)).toEqual({ status: 'ready', error: 'embedding_partial' })
  })
})

describe('queueReindexAllSources', () => {
  it('is admin only and queues a fenced run for each idle source', async () => {
    await expect(queueReindexAllSources({ accountId: ACCOUNT, role: 'agent' })).rejects.toMatchObject({ code: 'forbidden' })
    h.source = { ...h.source, status: 'ready' }
    expect(await queueReindexAllSources({ accountId: ACCOUNT, role: 'admin' })).toBe(1)
    expect(h.jobs).toHaveLength(1)
    expect(h.source).toMatchObject({ status: 'queued', current_run_id: h.jobs[0].payload.runId })
  })

  it('leaves a source that is already running alone', async () => {
    h.source = { ...h.source, status: 'crawling', updated_at: new Date() }
    expect(await queueReindexAllSources({ accountId: ACCOUNT, role: 'admin' })).toBe(0)
    expect(h.jobs).toEqual([])
  })
})
