import { withTenant } from '@/lib/db/tenant'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { assertOutboundAllowed } from '@/lib/billing/suspension'
import { isDryRun } from '@/lib/runtime/dry-run-guard'
import { clearExpiredPause, pauseActive } from '@/lib/inbox/automation-pause'
import { BotRepliesPausedError } from './bot-pause-error'
export { BotRepliesPausedError }
/**
 * Whether an agent (or a flow) has paused automated replies here. Stage 5: a
 * timed pause (bot_paused_until) counts only until its time; an expired one
 * reads as not paused and its flag is cleared, so readers of the bare column
 * see it resumed too (not in a read-only dry run).
 */
export async function botRepliesPaused(accountId: string, conversationId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, tx => tx.$queryRaw<{ bot_paused: boolean; bot_paused_until: Date | null }[]>`
    SELECT bot_paused, bot_paused_until FROM conversations WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`, getWorkerPrisma())
  if (!rows[0]) throw new Error('Conversation is unavailable for bot replies')
  const paused = pauseActive(rows[0])
  if (!paused && rows[0].bot_paused && !isDryRun()) await clearExpiredPause(accountId, conversationId)
  return paused
}
export async function assertBotRepliesEnabled(accountId: string, conversationId: string) {
  // A suspended workspace (unpaid after grace) sends nothing automatically.
  await assertOutboundAllowed(accountId)
  if (await botRepliesPaused(accountId, conversationId)) throw new BotRepliesPausedError()
}
