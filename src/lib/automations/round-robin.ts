import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant } from '@/lib/db/tenant'

/** The member after `last` in a stable order, wrapping to the start. */
export function pickNextMember(memberIds: string[], last: string | null): string | null {
  if (!memberIds.length) return null
  return (last ? memberIds.find((id) => id > last) : undefined) ?? memberIds[0]
}

/** Next owner/admin/agent in a fair rotation; viewers cannot reply, so they are skipped. */
export async function nextRoundRobinAgent(accountId: string): Promise<string | null> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    await tx.$executeRaw`INSERT INTO assignment_cursors(account_id) VALUES (${accountId}::uuid)
      ON CONFLICT (account_id) DO NOTHING`
    const [cursor] = await tx.$queryRaw<{ last_user_id: string | null }[]>`
      SELECT last_user_id::text FROM assignment_cursors WHERE account_id=${accountId}::uuid FOR UPDATE`
    const members = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id::text FROM account_memberships
      WHERE account_id=${accountId}::uuid AND role IN ('owner','admin','agent')
      ORDER BY user_id::text`
    const next = pickNextMember(members.map((m) => m.user_id), cursor?.last_user_id ?? null)
    if (next) {
      await tx.$executeRaw`UPDATE assignment_cursors SET last_user_id=${next}::uuid
        WHERE account_id=${accountId}::uuid`
    }
    return next
  }, getWorkerPrisma())
}
