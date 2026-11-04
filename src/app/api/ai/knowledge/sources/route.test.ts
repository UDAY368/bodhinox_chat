import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const SOURCE = '33333333-3333-4333-8333-333333333333'
const h = vi.hoisted(() => ({
  role: 'admin', limited: false,
  listSources: vi.fn(), createSource: vi.fn(), getSource: vi.fn(), deleteSource: vi.fn(), recrawlSource: vi.fn(),
  createFileSource: vi.fn(), extractFileText: vi.fn(), updateSourceAccess: vi.fn(), restricted: false,
}))

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }))
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}))
vi.mock('@/lib/auth/permissions', async () => {
  const { ForbiddenError } = await import('@/lib/auth/errors')
  return { requirePermission: async () => { if (h.restricted) throw new ForbiddenError('This feature is turned off for your role') } }
})
vi.mock('@/lib/ai/knowledge-sources', async (original) => ({
  ...(await original<typeof import('@/lib/ai/knowledge-sources')>()),
  listSources: h.listSources, createSource: h.createSource, getSource: h.getSource, deleteSource: h.deleteSource,
  recrawlSource: h.recrawlSource, createFileSource: h.createFileSource, updateSourceAccess: h.updateSourceAccess,
}))
vi.mock('@/lib/ai/file-extract', async (original) => ({
  ...(await original<typeof import('@/lib/ai/file-extract')>()),
  extractFileText: h.extractFileText,
}))

import { FileExtractError } from '@/lib/ai/file-extract'
import { KnowledgeSourceError } from '@/lib/ai/knowledge-sources'
import { GET, POST } from './route'
import { DELETE, GET as GET_ONE, PATCH, POST as RECRAWL } from './[id]/route'
import { POST as UPLOAD } from '../upload/route'

const ctx = { accountId: ACCOUNT, userId: USER, role: 'admin' }
const params = { params: Promise.resolve({ id: SOURCE }) }
const json = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
function upload(file?: File, title?: string) {
  const form = new FormData()
  if (file) form.set('file', file)
  if (title) form.set('title', title)
  return new Request('http://localhost/api/ai/knowledge/upload', { method: 'POST', body: form })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.role = 'admin'
  h.limited = false
  h.restricted = false
  h.updateSourceAccess.mockResolvedValue({ id: SOURCE, min_role: 'admin', customer_facing: false })
  h.listSources.mockResolvedValue([{ id: SOURCE }])
  h.createSource.mockResolvedValue({ id: SOURCE, status: 'queued' })
  h.getSource.mockResolvedValue({ source: { id: SOURCE }, pages: [] })
  h.deleteSource.mockResolvedValue(true)
  h.recrawlSource.mockResolvedValue({ id: SOURCE, status: 'queued' })
  h.createFileSource.mockResolvedValue({ id: SOURCE, kind: 'file' })
  h.extractFileText.mockResolvedValue({ kind: 'pdf', text: 'Extracted', pages: 1, truncated: false })
})

describe('/api/ai/knowledge/sources', () => {
  it('lists sources for any member', async () => {
    h.role = 'viewer'
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sources: [{ id: SOURCE }] })
    expect(h.listSources).toHaveBeenCalledWith({ ...ctx, role: 'viewer' })
  })

  it('adds a website for an admin and queues it', async () => {
    const res = await POST(json({ kind: 'website', url: 'example.com', page_limit: 20 }))
    expect(res.status).toBe(201)
    expect(h.createSource).toHaveBeenCalledWith(ctx, { kind: 'website', url: 'https://example.com/', page_limit: 20 })
  })

  it.each(['agent', 'viewer'])('refuses to add a source for %s', async (role) => {
    h.role = role
    const res = await POST(json({ kind: 'website', url: 'example.com' }))
    expect(res.status).toBe(403)
    expect(h.createSource).not.toHaveBeenCalled()
  })

  it('refuses private addresses and bad input with a code', async () => {
    const res = await POST(json({ kind: 'website', url: 'http://10.0.0.1/' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_url')
    expect((await POST(json({ kind: 'nope' }))).status).toBe(400)
    expect(h.createSource).not.toHaveBeenCalled()
  })

  it('reports the source limit and rate limit', async () => {
    h.createSource.mockRejectedValue(new KnowledgeSourceError('limit_reached'))
    expect((await POST(json({ kind: 'text', title: 'a', content: 'b' }))).status).toBe(409)
    h.limited = true
    expect((await POST(json({ kind: 'text', title: 'a', content: 'b' }))).status).toBe(429)
  })
})

describe('/api/ai/knowledge/sources/:id', () => {
  it('shows a source to any member, 404 when missing', async () => {
    h.role = 'viewer'
    expect((await GET_ONE(new Request('http://localhost/x'), params)).status).toBe(200)
    h.getSource.mockResolvedValue(null)
    expect((await GET_ONE(new Request('http://localhost/x'), params)).status).toBe(404)
  })

  it('re-crawls for an admin; 409 while running; 403 for an agent', async () => {
    expect((await RECRAWL(new Request('http://localhost/x', { method: 'POST' }), params)).status).toBe(202)
    expect(h.recrawlSource).toHaveBeenCalledWith(ctx, SOURCE)
    h.recrawlSource.mockRejectedValue(new KnowledgeSourceError('busy'))
    expect((await RECRAWL(new Request('http://localhost/x', { method: 'POST' }), params)).status).toBe(409)
    h.role = 'agent'
    expect((await RECRAWL(new Request('http://localhost/x', { method: 'POST' }), params)).status).toBe(403)
  })

  it('deletes for an admin; 404 when missing; 403 for an agent', async () => {
    expect((await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params)).status).toBe(200)
    h.deleteSource.mockResolvedValue(false)
    expect((await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params)).status).toBe(404)
    h.role = 'agent'
    expect((await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params)).status).toBe(403)
  })
})

describe('knowledge source access', () => {
  const patch = (body: unknown) => new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

  it('lets an admin with ai.knowledge make a source admin-only', async () => {
    const res = await PATCH(patch({ min_role: 'admin' }), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ source: { id: SOURCE, min_role: 'admin', customer_facing: false } })
    expect(h.updateSourceAccess).toHaveBeenCalledWith(ctx, SOURCE, { min_role: 'admin' })
  })

  it('refuses agents, admins restricted from ai.knowledge, and the rate limit', async () => {
    h.role = 'agent'
    expect((await PATCH(patch({ min_role: 'admin' }), params)).status).toBe(403)
    h.role = 'admin'
    h.restricted = true
    expect((await PATCH(patch({ min_role: 'admin' }), params)).status).toBe(403)
    h.restricted = false
    h.limited = true
    expect((await PATCH(patch({ min_role: 'admin' }), params)).status).toBe(429)
    expect(h.updateSourceAccess).not.toHaveBeenCalled()
  })

  it('refuses invalid bodies and an admin-only source used in customer replies', async () => {
    for (const body of [{}, { min_role: 'viewer' }, { customer_facing: 'yes' }, { min_role: 'agent', extra: 1 }]) {
      const res = await PATCH(patch(body), params)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('invalid_input')
    }
    h.updateSourceAccess.mockRejectedValue(new KnowledgeSourceError('invalid_input'))
    expect((await PATCH(patch({ customer_facing: true }), params)).status).toBe(400)
    h.updateSourceAccess.mockRejectedValue(new KnowledgeSourceError('not_found'))
    expect((await PATCH(patch({ customer_facing: false }), params)).status).toBe(404)
  })

  it('needs ai.knowledge only when a new source chooses its access', async () => {
    h.restricted = true
    expect((await POST(json({ kind: 'text', title: 'a', content: 'b' }))).status).toBe(201)
    expect((await POST(json({ kind: 'text', title: 'a', content: 'b', min_role: 'admin' }))).status).toBe(403)
    h.restricted = false
    expect((await POST(json({ kind: 'text', title: 'a', content: 'b', min_role: 'admin' }))).status).toBe(201)
    expect(h.createSource).toHaveBeenLastCalledWith(ctx, { kind: 'text', title: 'a', content: 'b', min_role: 'admin' })
    const bad = await POST(json({ kind: 'text', title: 'a', content: 'b', min_role: 'admin', customer_facing: true }))
    expect(bad.status).toBe(400)
  })
})

describe('/api/ai/knowledge/upload', () => {
  it('extracts the file and stores it as a queued source', async () => {
    const res = await UPLOAD(upload(new File([new Uint8Array([1, 2, 3])], 'policy.pdf', { type: 'application/pdf' }), 'Refund policy'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ source: { id: SOURCE, kind: 'file' }, truncated: false })
    expect(h.createFileSource).toHaveBeenCalledWith(ctx, { title: 'Refund policy', text: 'Extracted' })
  })

  it('uses the file name as the title by default', async () => {
    await UPLOAD(upload(new File(['x'], 'faq.docx')))
    expect(h.createFileSource).toHaveBeenCalledWith(ctx, { title: 'faq.docx', text: 'Extracted' })
  })

  it('refuses non-admins, missing files and unreadable files', async () => {
    h.extractFileText.mockRejectedValue(new FileExtractError('unsupported_type'))
    expect((await UPLOAD(upload(new File(['x'], 'a.gif')))).status).toBe(415)
    expect((await UPLOAD(upload())).status).toBe(400)
    h.role = 'agent'
    expect((await UPLOAD(upload(new File(['x'], 'a.pdf')))).status).toBe(403)
    expect(h.createFileSource).not.toHaveBeenCalled()
  })

  it('refuses a body over the size cap before parsing it', async () => {
    const big = new Request('http://localhost/x', { method: 'POST', body: 'x', headers: { 'content-length': String(20 * 1024 * 1024), 'content-type': 'multipart/form-data; boundary=x' } })
    expect((await UPLOAD(big)).status).toBe(413)
    expect(h.extractFileText).not.toHaveBeenCalled()
  })
})
