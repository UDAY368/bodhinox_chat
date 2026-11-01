// Records a campaign link click and returns where to send the visitor.
// Only the campaign's stored destination is ever returned (see tracking.ts).

import { createHash } from 'node:crypto';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { CLICK_TOKEN } from './tracking';

/** The destination for a token without recording anything (rate-limited repeat hits). */
export async function clickDestination(token: string): Promise<string | null> {
  if (!CLICK_TOKEN.test(token)) return null;
  const [hit] = await getWorkerPrisma().$queryRaw<{ tracked_url: string }[]>`SELECT tracked_url FROM resolve_click_token(${token})`;
  return hit?.tracked_url ?? null;
}

/** The destination for a valid token after recording the click, or null for an unknown token. */
export async function recordClick(token: string, ip: string | null): Promise<string | null> {
  if (!CLICK_TOKEN.test(token)) return null;
  const db = getWorkerPrisma();
  const [hit] = await db.$queryRaw<{ account_id: string; broadcast_id: string; recipient_id: string; tracked_url: string }[]>`
    SELECT account_id::text, broadcast_id::text, recipient_id::text, tracked_url FROM resolve_click_token(${token})`;
  if (!hit) return null;
  // Keyed hash: the stored value cannot be reversed to an IP without the server key.
  const ipHash = ip ? createHash('sha256').update(`${ip}|${process.env.ENCRYPTION_KEY ?? ''}`).digest('hex') : null;
  await withTenant({ accountId: hit.account_id, role: 'owner' }, async (tx) => {
    await tx.$executeRaw`INSERT INTO broadcast_clicks(account_id,broadcast_id,recipient_id,ip_hash)
      VALUES(${hit.account_id}::uuid,${hit.broadcast_id}::uuid,${hit.recipient_id}::uuid,${ipHash})`;
    // click_count counts people, so only a recipient's first click raises it.
    const first = await tx.$executeRaw`UPDATE broadcast_recipients SET clicked_at=now()
      WHERE account_id=${hit.account_id}::uuid AND id=${hit.recipient_id}::uuid AND clicked_at IS NULL`;
    if (first) await tx.$executeRaw`UPDATE broadcasts SET click_count=click_count+1
      WHERE account_id=${hit.account_id}::uuid AND id=${hit.broadcast_id}::uuid`;
  }, db);
  return hit.tracked_url;
}
