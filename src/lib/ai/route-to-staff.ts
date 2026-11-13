// Route to staff (Assistant features): a customer's health or other sensitive
// question goes to a person in EVERY conversation, not only in conversations
// the AI agent answers (the agent already hands those off itself).
//
// Runs as the inbound 'ai_route_staff' stage after the bots had their turn,
// for typed customer text, under the inbound's stage checkpoint (once per
// message). Deterministic: the keyword classifier (safety/sensitive.ts), no
// model call and no tokens. It still respects the workspace's switch, the
// deployment kill switch and the monthly budget (paused when the budget is
// used up while "pause the AI" is on), as every assistant feature does.
//
// When it fires on a conversation nobody owns yet (no person assigned, bot not
// paused, AI not turned off) it pauses the bot for staff, assigns the AI
// handoff agent when one is set, leaves the usual handoff note and records a
// 'route_to_staff' row in ai_suggestions (categories only) for the Quality
// tab. A conversation a person or the AI already handed off is left alone.
// Never throws; never logs customer text.

import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant } from '@/lib/db/tenant'
import { databaseAdmin } from './admin-client'
import { aiDeploymentEnabled } from './gate'
import { pauseConversationForStaff } from './handoff'
import { logAiEvent } from './log'
import { classifySensitive } from './safety/sensitive'
import { budgetUsedUp, readAiSettings } from './settings'

export const ROUTE_PROMPT_VERSION = 'route.v1'
export const ROUTE_SUMMARY = 'Routed to staff: the customer asked a sensitive (health or safety) question. A person should answer it; the AI will not.'

export interface RouteInboundArgs {
  accountId: string
  conversationId: string
  contactId: string
  /** The workspace's WhatsApp config owner: audit identity of the recorded row. */
  configOwnerUserId: string
  text: string
}

/** True when the conversation was handed to staff. */
export async function routeSensitiveInbound(args: RouteInboundArgs): Promise<boolean> {
  if (!aiDeploymentEnabled() || !args.text.trim()) return false
  const sensitive = classifySensitive(args.text)
  if (!sensitive.sensitive) return false
  const { accountId, conversationId, contactId } = args
  try {
    const prisma = getWorkerPrisma()
    const prep = await withTenant({ accountId, role: 'owner' }, async (tx) => {
      const settings = await readAiSettings(tx, accountId)
      if (!settings.route_to_staff_enabled || await budgetUsedUp(tx, accountId, settings)) return null
      const [conv] = await tx.$queryRaw<{ owned: boolean }[]>`SELECT (assigned_agent_id IS NOT NULL OR bot_paused OR ai_autoreply_disabled) AS owned
        FROM conversations WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid AND contact_id=${contactId}::uuid`
      if (!conv || conv.owned) return null
      const [config] = await tx.$queryRaw<{ handoff_agent_id: string | null }[]>`SELECT handoff_agent_id::text AS handoff_agent_id
        FROM ai_configs WHERE account_id=${accountId}::uuid`
      return { handoffAgentId: config?.handoff_agent_id ?? null }
    }, prisma)
    if (!prep) return false
    await pauseConversationForStaff(databaseAdmin({ accountId, userId: args.configOwnerUserId, role: 'owner' }), {
      accountId, conversationId, contactId, summary: ROUTE_SUMMARY, handoffAgentId: prep.handoffAgentId,
    })
    await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`
      INSERT INTO ai_suggestions(account_id, conversation_id, kind, output, guard_flags, prompt_version, created_by)
      VALUES (${accountId}::uuid, ${conversationId}::uuid, 'route_to_staff', ${JSON.stringify({ categories: sensitive.categories, source: 'inbound' })}::jsonb,
        ARRAY['sensitive_topic']::text[], ${ROUTE_PROMPT_VERSION}, ${args.configOwnerUserId}::uuid)`, prisma)
    logAiEvent({ feature: 'route_to_staff', reason: 'routed', accountId })
    return true
  } catch (error) {
    logAiEvent({ feature: 'route_to_staff', reason: 'route_failed', accountId, error })
    return false
  }
}
