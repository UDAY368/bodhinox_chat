import { withTenant } from '@/lib/db/tenant'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { assertOutboundAllowed } from '@/lib/billing/suspension'
import { BotRepliesPausedError } from './bot-pause-error'
export { BotRepliesPausedError }
export async function botRepliesPaused(accountId: string, conversationId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, tx => tx.$queryRaw<{ bot_paused: boolean }[]>`SELECT bot_paused FROM conversations WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`, getWorkerPrisma())
  if (!rows[0]) throw new Error('Conversation is unavailable for bot replies')
  return rows[0].bot_paused
}
export async function assertBotRepliesEnabled(accountId: string, conversationId: string) {
  // A suspended workspace (unpaid after grace) sends nothing automatically.
  await assertOutboundAllowed(accountId)
  if (await botRepliesPaused(accountId, conversationId)) throw new BotRepliesPausedError()
}
