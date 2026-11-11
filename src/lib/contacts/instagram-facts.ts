// Stage 5 (5E): a contact's Instagram facts for the contact page and the inbox
// panel, read from what is stored (profile facts the worker wrote on the
// identity, the contact's Instagram subscription, the last Instagram message
// from them). Rendering never calls Meta. Any member may read them; the
// identity's handle is masked by the caller's route like the identity itself.
import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { STANDARD_WINDOW_MS } from '@/lib/instagram/window';
import { channelConsent, type ConsentState } from './channel-consent';

export interface InstagramIdentityFacts {
  /** contact_channel_identities.id */
  id: string;
  follows_business: boolean | null;
  business_follows: boolean | null;
  is_verified: boolean | null;
  follower_count: number | null;
  profile_checked_at: string | null;
}

export interface InstagramFactsView {
  /** opted_out while instagram_opted_out_at is set, opted_in after a START, null when never chosen. */
  subscription: ConsentState | null;
  /** The customer's last Instagram message, null when they never wrote. */
  last_interaction_at: string | null;
  /** When the standard 24-hour messaging window closes; null when it is closed. */
  window_open_until: string | null;
  identities: InstagramIdentityFacts[];
}

/** The end of the standard window opened by `lastCustomerAt`, or null when it is closed (or never opened). */
export function windowOpenUntil(lastCustomerAt: Date | null, now: Date = new Date()): Date | null {
  if (!lastCustomerAt || Number.isNaN(lastCustomerAt.getTime())) return null;
  const closes = new Date(lastCustomerAt.getTime() + STANDARD_WINDOW_MS);
  return closes > now ? closes : null;
}

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);

/** The stored Instagram facts of a contact in the caller's workspace; null for an unknown contact. */
export async function loadInstagramFacts(tenant: TenantContext, contactId: string, now: Date = new Date()): Promise<InstagramFactsView | null> {
  return withTenant(tenant, async (tx) => {
    const contacts = await tx.$queryRaw<{ opted_out_at: Date | null; instagram_opted_out_at: Date | null; instagram_opted_in_at: Date | null; last_at: Date | null }[]>(Prisma.sql`
      SELECT c.opted_out_at, c.instagram_opted_out_at, c.instagram_opted_in_at,
        (SELECT max(m.created_at) FROM conversations v JOIN messages m ON m.account_id=v.account_id AND m.conversation_id=v.id
          WHERE v.account_id=c.account_id AND v.contact_id=c.id AND v.channel='instagram' AND m.sender_type='customer') AS last_at
      FROM contacts c WHERE c.account_id=${tenant.accountId}::uuid AND c.id=${contactId}::uuid`);
    const contact = contacts[0];
    if (!contact) return null;
    const identities = await tx.$queryRaw<{ id: string; follows_business: boolean | null; business_follows: boolean | null;
      is_verified: boolean | null; ig_follower_count: number | null; profile_checked_at: Date | null }[]>(Prisma.sql`
      SELECT id::text AS id, follows_business, business_follows, is_verified, ig_follower_count, profile_checked_at
      FROM contact_channel_identities WHERE account_id=${tenant.accountId}::uuid AND contact_id=${contactId}::uuid AND channel='instagram'
      ORDER BY created_at, id`);
    const last = contact.last_at ? new Date(contact.last_at) : null;
    return {
      subscription: channelConsent(contact, 'instagram'),
      last_interaction_at: iso(last),
      window_open_until: iso(windowOpenUntil(last, now)),
      identities: identities.map((row) => ({
        id: row.id,
        follows_business: row.follows_business,
        business_follows: row.business_follows,
        is_verified: row.is_verified,
        follower_count: row.ig_follower_count,
        profile_checked_at: iso(row.profile_checked_at),
      })),
    };
  });
}
