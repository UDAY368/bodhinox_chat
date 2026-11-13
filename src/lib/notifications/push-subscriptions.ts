/**
 * A member's own browser push subscriptions (push_subscriptions). The browser
 * hands over PushSubscription.toJSON(); only the known push services are
 * accepted (web-push.ts). RLS limits every read and write to the signed-in
 * member's own rows in this workspace.
 */
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import type { PushSubscriptionKeys } from './web-push';

/** Devices one member may register in one workspace. */
export const MAX_PUSH_DEVICES = 10;

function own(context: TenantContext): TenantContext & { userId: string } {
  if (!context.userId) throw new Error('Push subscriptions need a member');
  return context as TenantContext & { userId: string };
}

export async function countPushDevices(context: TenantContext): Promise<number> {
  const member = own(context);
  const rows = await withTenant(member, (tx) => tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM push_subscriptions
    WHERE account_id=${member.accountId}::uuid AND user_id=${member.userId}::uuid`);
  return rows[0]?.n ?? 0;
}

/** Store (or refresh the keys of) this browser's subscription; the oldest device goes past the limit. */
export async function savePushSubscription(context: TenantContext, subscription: PushSubscriptionKeys): Promise<void> {
  const member = own(context);
  await withTenant(member, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO push_subscriptions(account_id,user_id,endpoint,p256dh,auth)
      VALUES(${member.accountId}::uuid,${member.userId}::uuid,${subscription.endpoint},${subscription.p256dh},${subscription.auth})
      ON CONFLICT (account_id,user_id,endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`;
    await tx.$executeRaw`
      DELETE FROM push_subscriptions WHERE account_id=${member.accountId}::uuid AND user_id=${member.userId}::uuid
        AND id NOT IN (SELECT id FROM push_subscriptions
          WHERE account_id=${member.accountId}::uuid AND user_id=${member.userId}::uuid
          ORDER BY created_at DESC LIMIT ${MAX_PUSH_DEVICES})`;
  });
}

export async function deletePushSubscription(context: TenantContext, endpoint: string): Promise<boolean> {
  const member = own(context);
  const removed = await withTenant(member, (tx) => tx.$executeRaw`
    DELETE FROM push_subscriptions
    WHERE account_id=${member.accountId}::uuid AND user_id=${member.userId}::uuid AND endpoint=${endpoint}`);
  return removed > 0;
}
