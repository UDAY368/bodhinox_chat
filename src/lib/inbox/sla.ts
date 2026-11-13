import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { readInboxSettings } from './inbox-settings';
import { createNotification } from './notify';

/**
 * First-response SLA breaches. The conversation_lifecycle trigger stamps
 * first_response_due_at when an open conversation needs a person, and the
 * messages_first_response trigger stamps first_responded_at on the first
 * agent message. This sweep (inbox.sla_check, every minute per workspace)
 * finds open conversations past due without a reply and notifies the assignee
 * and the workspace's owners and admins once per conversation cycle
 * ('sla_breach', deduplicated by conversation and reopen count).
 *
 * Titles and bodies are fixed English text like the other notification
 * types; no customer content.
 */

export const SLA_CHECK_JOB = 'inbox.sla_check';
/** Breaches handled per sweep, newest due first; the next sweep continues. */
export const SLA_BATCH = 200;
/** Breaches older than this are not notified any more (e.g. after a long outage). */
export const SLA_LOOKBACK_DAYS = 7;

export const slaBreachKey = (conversationId: string, cycle: number) => `sla_breach:${conversationId}:${cycle}`;

export function slaBreachText(minutes: number | null): { title: string; body: string } {
  return {
    title: 'First reply overdue',
    body: minutes
      ? `A conversation has waited more than ${minutes} minutes for a first reply.`
      : 'A conversation has waited longer than the first-reply target.',
  };
}

type Breach = {
  id: string; assigned_agent_id: string | null; reopened_count: number; contact_id: string; whatsapp_config_id: string | null;
};

/** Notify one batch of breaches. Returns how many conversations were notified. */
export async function notifySlaBreaches(tx: TenantTransaction, accountId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - SLA_LOOKBACK_DAYS * 86_400_000);
  const breaches = await tx.$queryRaw<Breach[]>`SELECT c.id::text AS id,c.assigned_agent_id::text AS assigned_agent_id,c.reopened_count,
      c.contact_id::text AS contact_id,c.whatsapp_config_id::text AS whatsapp_config_id
    FROM conversations c
    WHERE c.account_id=${accountId}::uuid AND c.first_responded_at IS NULL AND c.first_response_due_at IS NOT NULL
      AND c.first_response_due_at <= ${now} AND c.first_response_due_at > ${since}
      AND c.status<>'closed' AND c.lifecycle_state<>'bot'
      AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.account_id=c.account_id AND n.type='sla_breach'
        AND n.dedupe_key='sla_breach:' || c.id::text || ':' || c.reopened_count::text)
      AND NOT EXISTS(SELECT 1 FROM notification_email_queue q WHERE q.account_id=c.account_id AND q.event='sla_breach'
        AND q.dedupe_key='sla_breach:' || c.id::text || ':' || c.reopened_count::text)
      AND NOT EXISTS(SELECT 1 FROM notification_push_queue q WHERE q.account_id=c.account_id AND q.event='sla_breach'
        AND q.dedupe_key='sla_breach:' || c.id::text || ':' || c.reopened_count::text)
    ORDER BY c.first_response_due_at DESC LIMIT ${SLA_BATCH}`;
  if (!breaches.length) return 0;
  const admins = await tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text AS user_id FROM account_memberships
    WHERE account_id=${accountId}::uuid AND role IN ('owner','admin')`;
  const settings = await readInboxSettings(tx, accountId);
  const text = slaBreachText(settings.sla_first_response_minutes);
  let notified = 0;
  for (const breach of breaches) {
    const userIds = [...new Set([...(breach.assigned_agent_id ? [breach.assigned_agent_id] : []), ...admins.map((a) => a.user_id)])];
    const result = await createNotification(tx, {
      accountId, userIds, event: 'sla_breach', ...text, link: `/inbox?c=${breach.id}`,
      dedupeKey: slaBreachKey(breach.id, breach.reopened_count),
      conversationId: breach.id, contactId: breach.contact_id, whatsappConfigId: breach.whatsapp_config_id,
    });
    if (result.inApp.length || result.emailQueued.length) notified++;
  }
  return notified;
}

export async function runSlaCheck(accountId: string, now: Date = new Date()): Promise<number> {
  return withTenant({ accountId, role: 'owner' }, (tx) => notifySlaBreaches(tx, accountId, now), getWorkerPrisma());
}
