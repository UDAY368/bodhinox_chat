// GET  /api/ai/knowledge/sources — knowledge sources, newest first (any member; below admin,
//   admin-only sources are left out).
//   200 { sources: KnowledgeSource[] }
// POST /api/ai/knowledge/sources — add a source and queue its first crawl or indexing (admin, rate limited).
//   { kind: 'website' | 'sitemap', url, title?, page_limit? (1-500, default 50) }
//   { kind: 'text', title, content (≤ 100,000 chars) }
//   Either kind may also set access: min_role ('agent' | 'admin', default 'agent') and
//   customer_facing (default true; false for an admin-only source). Setting either needs the
//   'ai.knowledge' permission (403 otherwise); an admin-only source used in customer replies is 400.
//   201 { source } (with min_role, customer_facing); 400 bad input or a URL that is not a public http(s) address; 409 source limit reached.
// The crawl runs in the worker; the source's status, pages_indexed and error code show its progress.

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { requirePermission } from '@/lib/auth/permissions'
import { createSource, listSources, parseSourceInput, setsAccess } from '@/lib/ai/knowledge-sources'
import { knowledgeSourceErrorResponse } from '@/lib/ai/knowledge-sources-http'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const noStore = { 'Cache-Control': 'no-store' }

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    return NextResponse.json({ sources: await listSources(tenantOf(ctx)) }, { headers: noStore })
  } catch (error) {
    return knowledgeSourceErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-sources:write:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const input = parseSourceInput(await request.json().catch(() => null))
    if (setsAccess(input)) await requirePermission(tenantOf(ctx), 'ai.knowledge')
    return NextResponse.json({ source: await createSource(tenantOf(ctx), input) }, { status: 201, headers: noStore })
  } catch (error) {
    return knowledgeSourceErrorResponse(error)
  }
}
