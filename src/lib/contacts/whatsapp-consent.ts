// WhatsApp consent recorded by a member (inbox contact panel, contact sheet).
// STOP / START from customers go through applyConsentKeyword in ./consent.
import { withTenant } from '@/lib/db/tenant';

/** 'cleared' removes an opt-out without recording an opt-in (the contact sheet's switch). */
export type WhatsAppConsentState = 'opted_in' | 'opted_out' | 'cleared';

/**
 * A member records a contact's WhatsApp consent by hand (the inbox and contact
 * sheet), in one tenant transaction with an audit row. Opting out keeps the
 * first opt-out; opting in clears the opt-out and stamps the opt-in. Returns
 * null when the contact is not in this workspace, else whether anything changed.
 * The audit row holds ids and the new state only, never contact details.
 */
export async function setWhatsAppConsent(
  tenant: { accountId: string; userId: string; role: 'owner' | 'admin' | 'agent' | 'viewer' },
  contactId: string,
  state: WhatsAppConsentState
): Promise<{ changed: boolean; contact: { opted_out_at: string | null; opt_out_source: string | null; opted_in_at: string | null; opt_in_source: string | null } } | null> {
  return withTenant(tenant, async (tx) => {
    const changed = state === 'cleared'
      ? await tx.$executeRaw`UPDATE contacts SET opted_out_at=NULL, opt_out_source=NULL, updated_at=now()
          WHERE account_id=${tenant.accountId}::uuid AND id=${contactId}::uuid AND opted_out_at IS NOT NULL`
      : state === 'opted_out'
      ? await tx.$executeRaw`UPDATE contacts SET opted_out_at=now(), opt_out_source='agent', updated_at=now()
          WHERE account_id=${tenant.accountId}::uuid AND id=${contactId}::uuid AND opted_out_at IS NULL`
      : await tx.$executeRaw`UPDATE contacts SET opted_out_at=NULL, opt_out_source=NULL, opted_in_at=now(), opt_in_source='agent', updated_at=now()
          WHERE account_id=${tenant.accountId}::uuid AND id=${contactId}::uuid
            AND (opted_out_at IS NOT NULL OR opted_in_at IS NULL)`;
    const rows = await tx.$queryRaw<Array<{ opted_out_at: Date | null; opt_out_source: string | null; opted_in_at: Date | null; opt_in_source: string | null }>>`
      SELECT opted_out_at, opt_out_source, opted_in_at, opt_in_source FROM contacts
      WHERE account_id=${tenant.accountId}::uuid AND id=${contactId}::uuid`;
    if (!rows.length) return null;
    if (changed > 0)
      await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
        VALUES(${tenant.accountId}::uuid, ${tenant.userId}::uuid, 'contact.consent_changed', ${contactId},
          ${JSON.stringify({ channel: 'whatsapp', state })}::jsonb)`;
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    const row = rows[0];
    return {
      changed: changed > 0,
      contact: { opted_out_at: iso(row.opted_out_at), opt_out_source: row.opt_out_source, opted_in_at: iso(row.opted_in_at), opt_in_source: row.opt_in_source },
    };
  });
}
