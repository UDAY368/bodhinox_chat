// A member switches a contact's Instagram subscription on the contact profile
// (Messaging card). Same columns and rules as an Instagram STOP / START and the
// bulk "unsubscribe from Instagram" action (channel-consent.ts): opting out
// keeps the first opt-out time, opting in clears it. Only a contact with an
// Instagram identity has a subscription. One tenant transaction with an
// audit row and a timeline row (ids and the new state only).
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { setChannelConsent, type ConsentState } from './channel-consent';
import { recordContactActivity } from './profile';

export async function setInstagramConsentByMember(
  tenant: TenantContext & { userId: string },
  contactId: string,
  state: ConsentState,
): Promise<'not_found' | 'no_identity' | { changed: boolean; contact: { instagram_opted_out_at: string | null; instagram_opted_in_at: string | null } }> {
  return withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<{ has_identity: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM contact_channel_identities i WHERE i.account_id=c.account_id AND i.contact_id=c.id AND i.channel='instagram') AS has_identity
      FROM contacts c WHERE c.account_id=${tenant.accountId}::uuid AND c.id=${contactId}::uuid FOR UPDATE OF c`;
    if (!rows[0]) return 'not_found';
    if (!rows[0].has_identity) return 'no_identity';
    const changed = await setChannelConsent(tx, tenant.accountId, contactId, 'instagram', state);
    if (changed) {
      await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
        VALUES(${tenant.accountId}::uuid, ${tenant.userId}::uuid, 'contact.consent_changed', ${contactId},
          ${JSON.stringify({ channel: 'instagram', state })}::jsonb)`;
      await recordContactActivity(tx, tenant, contactId, 'consent_changed', { channel: 'instagram', state });
    }
    const after = await tx.$queryRaw<{ instagram_opted_out_at: Date | null; instagram_opted_in_at: Date | null }[]>`
      SELECT instagram_opted_out_at, instagram_opted_in_at FROM contacts WHERE account_id=${tenant.accountId}::uuid AND id=${contactId}::uuid`;
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return { changed, contact: { instagram_opted_out_at: iso(after[0].instagram_opted_out_at), instagram_opted_in_at: iso(after[0].instagram_opted_in_at) } };
  });
}
