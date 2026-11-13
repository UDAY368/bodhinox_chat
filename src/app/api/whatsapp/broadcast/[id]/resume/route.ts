import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { requirePermission } from '@/lib/auth/permissions'
import { enqueueJob } from '@/lib/jobs/queue'
import { BroadcastError, broadcastNumberError } from '@/lib/whatsapp/broadcast-core'
import { loadSenderConfig } from '@/lib/whatsapp/sender-config'
import { flagLegacyUncertain, RESUME_MAX_PER_REQUEST, scopeStatuses } from '@/lib/whatsapp/broadcast-resume'
import { randomUUID } from 'node:crypto'
import { unpauseBroadcast } from '@/lib/broadcasts/pause'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db, accountId, userId, role } = await requireRole('agent')
    await requirePermission({ accountId, userId, role }, 'campaigns.send')
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const scope = body.scope === 'failed' || body.scope === 'all' ? body.scope : 'pending'
    const { data, error } = await db.from('broadcasts').select('id,status,scheduled_at,whatsapp_config_id,channel').eq('id', id).eq('account_id', accountId).single()
    if (error || !data) return NextResponse.json({ error: 'Broadcast unavailable' }, { status: 404 })
    // A scheduled campaign whose time has passed but has not started was held
    // (its number was disconnected) and may be resumed; one still due later may not.
    const due = data.status === 'scheduled' && !!data.scheduled_at && new Date(data.scheduled_at as string).getTime() <= Date.now()
    // A draft was never sent: it must go through create/schedule, not resume.
    if ((data.status === 'scheduled' && !due) || data.status === 'cancelled' || data.status === 'draft')
      return NextResponse.json({ error: 'Draft, scheduled or cancelled campaigns cannot be resumed' }, { status: 409 })
    const instagram = data.channel === 'instagram'
    // Its own number (the default when it has none) must be connected: a held
    // campaign stays held, never moved to another number. Instagram campaigns
    // check their account per recipient when they send.
    if (!instagram) try {
      await loadSenderConfig(db, accountId, (data.whatsapp_config_id as string | null | undefined) ?? null)
    } catch (numberError) {
      const mapped = broadcastNumberError(numberError)
      if (mapped instanceof BroadcastError) return NextResponse.json({ error: mapped.message, code: mapped.code }, { status: mapped.status })
      throw numberError
    }
    const headerMediaUrl = !instagram && typeof body.headerMediaUrl === 'string' ? body.headerMediaUrl.trim() : undefined
    if (headerMediaUrl && headerMediaUrl.length > 2048) return NextResponse.json({ error: 'Invalid media URL' }, { status: 400 })
    // The recipients this request covers, for the confirmation. Uncertain sends are
    // left out: they wait for reconciliation on the campaign page.
    if (scope !== 'pending') await flagLegacyUncertain(db, id)
    const counted = await db.from('broadcast_recipients').select('id', { count: 'exact', head: true })
      .eq('broadcast_id', id).in('status', scopeStatuses(scope)).is('outcome_uncertain_at', null)
    if (counted.error) throw new Error('Broadcast recipient count failed')
    const inScope = counted.count ?? 0
    // Pending rows continue pass after pass; failed rows beyond one pass need another retry.
    const resuming = scope === 'pending' ? inScope : Math.min(inScope, RESUME_MAX_PER_REQUEST)
    // A retry request id lets the worker give rows Meta failed after accepting them one new send.
    const retryId = scope === 'pending' ? undefined : randomUUID()
    // A paused campaign goes back to sending before its pass is queued (the dispatcher skips paused ones).
    if (data.status === 'paused') await unpauseBroadcast({ accountId, userId, role }, id)
    const jobId = await enqueueJob('broadcast.dispatch', { broadcastId: id, scope, ...(retryId ? { retryId } : {}), ...(headerMediaUrl ? { headerMediaUrl } : {}) }, { tenantId: accountId, requeueCompleted: true, dedupeKey: retryId ? `broadcast:${id}:retry:${retryId}` : `broadcast:${id}:initial` })
    return NextResponse.json({ success: true, broadcast_id: id, scope, job_id: jobId, queued: true, resuming, remaining: inScope - resuming, unsendable: 0 }, { status: 202 })
  } catch (error) { return toErrorResponse(error) }
}
