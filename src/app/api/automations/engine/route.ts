import { withJobScope } from '@/lib/jobs/scope'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { parseAutomationChannel } from '@/lib/automations/validate'
import { getT } from '@/lib/i18n/translate'
import type { AutomationTriggerType } from '@/types'

/**
 * Manual trigger for testing or for external integrations that want
 * to fire automations. Auth is required — we resolve the caller's
 * account_id and dispatch over the account's automations.
 *
 * `channel` ('whatsapp' or 'instagram') picks which channel's automations
 * run; absent means WhatsApp, as before channels existed. A context
 * conversation_id must be on that channel (the engine refuses it otherwise).
 */
export async function POST(request: Request) {
  // Firing automations sends outbound messages — a write action. Require
  // at least `agent`; a viewer must not be able to trigger sends.
  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body?.trigger_type) {
    return NextResponse.json({ error: 'trigger_type required' }, { status: 400 })
  }
  const channel = parseAutomationChannel(body.channel)
  if (!channel) {
    return NextResponse.json({ error: getT('Automations.channelSection')('invalidChannel'), code: 'invalid_channel' }, { status: 400 })
  }

  await withJobScope({ accountId, role: 'owner' }, () => runAutomationsForTrigger({
    accountId,
    channel,
    triggerType: body.trigger_type as AutomationTriggerType,
    contactId: body.contact_id ?? null,
    context: body.context ?? {},
  }))

  return NextResponse.json({ ok: true })
}
