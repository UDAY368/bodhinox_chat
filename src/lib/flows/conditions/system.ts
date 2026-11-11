// The `system` condition subject (Stage 5): facts the platform keeps about
// the run's contact and conversation (SYSTEM_FACTS in ../types).
//
//   ig_username          the contact's stored Instagram username on this
//                        conversation's Instagram account (lowercase, no @)
//   last_interaction_at  the day (YYYY-MM-DD, UTC) of the contact's last
//                        message in this conversation
//   window_open_until    the day (YYYY-MM-DD, UTC) the automated messaging
//                        window closes; missing when it is closed
//   subscribed           "true"/"false": not opted out on the run's channel
//                        (Instagram: instagram_opted_out_at and the contact-wide
//                        STOP; WhatsApp: the contact-wide STOP)
//   contact_id           the contact's id
//
// Dates are days so the existing ordering operators (before/after a date)
// compare them. Every read is scoped to the run's workspace and conversation;
// nothing is logged.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramWindow, STANDARD_WINDOW_MS } from '@/lib/instagram/window';
import type { Channel } from '@/lib/channels/capabilities';
import { SYSTEM_FACTS } from '../types';

interface SystemRun { account_id: string; contact_id: string | null; conversation_id: string | null }

const day = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined;
  const t = new Date(value);
  return Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 10) : undefined;
};

/** Whether the contact may get automated messages on the channel, from stored consent fields. Pure. */
export function subscribedOn(channel: Channel, contact: { opted_out_at?: unknown; instagram_opted_out_at?: unknown }): boolean {
  if (contact.opted_out_at) return false;
  return channel === 'instagram' ? !contact.instagram_opted_out_at : true;
}

/** When the automated window closes, from the last customer message (null: closed or never opened). Pure. */
export function windowOpenUntil(channel: Channel, lastCustomerAt: Date | null, adReferralAt: Date | null, now: Date): Date | null {
  if (!lastCustomerAt && !adReferralAt) return null;
  if (channel === 'instagram') {
    const decision = instagramWindow({ lastCustomerAt, sender: 'automated', humanAgentEnabled: false, adReferralAt,
      ctdEnabled: instagramConfig()?.ctdWindowEnabled === true, now });
    return decision.allowed ? decision.closesAt : null;
  }
  if (!lastCustomerAt) return null;
  const closes = new Date(lastCustomerAt.getTime() + STANDARD_WINDOW_MS);
  return closes > now ? closes : null;
}

export async function systemSubject(run: SystemRun, key: string, channel: Channel, now: Date = new Date()): Promise<string | undefined> {
  if (!(SYSTEM_FACTS as readonly string[]).includes(key)) return undefined;
  if (key === 'contact_id') return run.contact_id ?? undefined;
  if (!run.contact_id) return undefined;
  const { account_id: accountId, contact_id: contactId, conversation_id: conversationId } = run;
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    if (key === 'subscribed') {
      const [row] = await tx.$queryRaw<{ opted_out_at: Date | null; instagram_opted_out_at: Date | null }[]>(Prisma.sql`
        SELECT opted_out_at, instagram_opted_out_at FROM contacts WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`);
      return row ? String(subscribedOn(channel, row)) : undefined;
    }
    if (!conversationId) return undefined;
    if (key === 'ig_username') {
      const [row] = await tx.$queryRaw<{ username: string | null }[]>(Prisma.sql`
        SELECT i.username FROM conversations v
        JOIN contact_channel_identities i ON i.account_id=v.account_id AND i.contact_id=v.contact_id
          AND i.instagram_account_id=v.instagram_account_id AND i.channel='instagram'
        WHERE v.account_id=${accountId}::uuid AND v.id=${conversationId}::uuid AND v.contact_id=${contactId}::uuid`);
      const username = row?.username?.trim().replace(/^@/, '').toLowerCase();
      return username || undefined;
    }
    const [row] = await tx.$queryRaw<{ last_customer_at: Date | null; ad_referral_at: Date | null }[]>(Prisma.sql`
      SELECT max(m.created_at) AS last_customer_at,
        max(m.created_at) FILTER (WHERE upper(m.interactive_payload #>> '{ig,referral,source}')='ADS') AS ad_referral_at
      FROM messages m WHERE m.account_id=${accountId}::uuid AND m.conversation_id=${conversationId}::uuid AND m.sender_type='customer'`);
    const last = row?.last_customer_at ? new Date(row.last_customer_at) : null;
    if (key === 'last_interaction_at') return day(last);
    const ad = row?.ad_referral_at ? new Date(row.ad_referral_at) : null;
    return day(windowOpenUntil(channel, last, ad, now));
  }, getWorkerPrisma());
}
