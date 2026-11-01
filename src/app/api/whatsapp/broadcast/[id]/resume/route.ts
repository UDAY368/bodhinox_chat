import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { enqueueJob } from '@/lib/jobs/queue'
import { randomUUID } from 'node:crypto'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db, accountId } = await requireRole('agent')
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const scope = body.scope === 'failed' || body.scope === 'all' ? body.scope : 'pending'
    const { data, error } = await db.from('broadcasts').select('id,status').eq('id', id).eq('account_id', accountId).single()
    if (error || !data) return NextResponse.json({ error: 'Broadcast unavailable' }, { status: 404 })
    if (data.status === 'scheduled' || data.status === 'cancelled')
      return NextResponse.json({ error: 'Scheduled or cancelled campaigns cannot be resumed' }, { status: 409 })
    const headerMediaUrl = typeof body.headerMediaUrl === 'string' ? body.headerMediaUrl.trim() : undefined
    if (headerMediaUrl && headerMediaUrl.length > 2048) return NextResponse.json({ error: 'Invalid media URL' }, { status: 400 })
    const jobId = await enqueueJob('broadcast.dispatch', { broadcastId: id, scope, ...(headerMediaUrl ? { headerMediaUrl } : {}) }, { tenantId: accountId, requeueCompleted: true, dedupeKey: scope === 'pending' ? `broadcast:${id}:initial` : `broadcast:${id}:retry:${randomUUID()}` })
    return NextResponse.json({ success: true, broadcast_id: id, scope, job_id: jobId, queued: true, resuming: 0, remaining: 0, unsendable: 0 }, { status: 202 })
  } catch (error) { return toErrorResponse(error) }
}
