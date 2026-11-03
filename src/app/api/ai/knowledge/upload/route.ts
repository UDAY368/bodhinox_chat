// POST /api/ai/knowledge/upload multipart { file, title? } — add a PDF, DOCX, TXT or Markdown file to the
//   knowledge base (admin, rate limited). The text is extracted here, within size and page caps, and stored as
//   a 'file' source; chunking and embedding are queued for the worker.
//   201 { source, truncated }; 400 no file; 413 over 10 MB or 300 pages; 415 unsupported type; 422 unreadable or empty.
// The file itself is not kept, only its extracted text.

import { NextResponse } from 'next/server'
import { readBoundedBody } from '@/lib/api/bounded-body'
import { requireRole } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { extractFileText, FILE_MAX_BYTES } from '@/lib/ai/file-extract'
import { createFileSource, KnowledgeSourceError, SOURCE_TITLE_MAX } from '@/lib/ai/knowledge-sources'
import { knowledgeSourceErrorResponse } from '@/lib/ai/knowledge-sources-http'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const runtime = 'nodejs'

/** Room for the multipart envelope around the largest allowed file. */
const BODY_LIMIT = FILE_MAX_BYTES + 64 * 1024

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-sources:upload:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const bytes = await readBoundedBody(request, BODY_LIMIT)
    const form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } })
      .formData()
      .catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) throw new KnowledgeSourceError('invalid_input')
    const rawTitle = form?.get('title')
    const title = (typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle : file.name || 'Document')
      .replace(/\s+/g, ' ').trim().slice(0, SOURCE_TITLE_MAX)
    const extracted = await extractFileText(new Uint8Array(await file.arrayBuffer()), { name: file.name, contentType: file.type })
    const source = await createFileSource(tenantOf(ctx), { title, text: extracted.text })
    return NextResponse.json({ source, truncated: extracted.truncated }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return knowledgeSourceErrorResponse(error)
  }
}
