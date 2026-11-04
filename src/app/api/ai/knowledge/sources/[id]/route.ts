// GET    /api/ai/knowledge/sources/:id — the source and its pages (any member; an admin-only
//   source is 404 below admin).
//   200 { source, pages: [{ id, title, source_url, fetched_at }] }; 404.
// POST   /api/ai/knowledge/sources/:id — re-crawl a website or sitemap, or re-index a file, text or
//   learned source (admin, rate limited). 202 { source }; 404; 409 a run is already in progress.
// PATCH  /api/ai/knowledge/sources/:id — change who may see the source and whether it grounds customer
//   replies: { min_role?: 'agent' | 'admin', customer_facing?: boolean } (admin plus 'ai.knowledge',
//   rate limited, audited 'ai.knowledge_access_updated'). Making a source admin-only also turns
//   customer use off. 200 { source }; 400 invalid (an admin-only source cannot be customer-facing); 403; 404.
// DELETE /api/ai/knowledge/sources/:id — delete the source with its pages and chunks (admin). 200 { success }; 404.

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { requirePermission } from '@/lib/auth/permissions'
import { deleteSource, getSource, KnowledgeSourceError, parseAccessPatch, recrawlSource, updateSourceAccess } from '@/lib/ai/knowledge-sources'
import { knowledgeSourceErrorResponse } from '@/lib/ai/knowledge-sources-http'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }
const noStore = { 'Cache-Control': 'no-store' }

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('viewer')
    const found = await getSource(tenantOf(ctx), (await params).id)
    if (!found) throw new KnowledgeSourceError('not_found')
    return NextResponse.json(found, { headers: noStore })
  } catch (error) {
    return knowledgeSourceErrorResponse(error)
  }
}

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-sources:write:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const source = await recrawlSource(tenantOf(ctx), (await params).id)
    return NextResponse.json({ source }, { status: 202, headers: noStore })
  } catch (error) {
    return knowledgeSourceErrorResponse(error)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    await requirePermission(tenantOf(ctx), 'ai.knowledge')
    const limit = checkRateLimit(`ai-sources:write:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const patch = parseAccessPatch(await request.json().catch(() => null))
    const source = await updateSourceAccess(tenantOf(ctx), (await params).id, patch)
    return NextResponse.json({ source }, { headers: noStore })
  } catch (error) {
    return knowledgeSourceErrorResponse(error)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    if (!(await deleteSource(tenantOf(ctx), (await params).id))) throw new KnowledgeSourceError('not_found')
    return NextResponse.json({ success: true })
  } catch (error) {
    return knowledgeSourceErrorResponse(error)
  }
}
