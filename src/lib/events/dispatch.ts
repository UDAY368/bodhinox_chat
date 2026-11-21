import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { createAdminClient } from '@/lib/data/admin';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { startFlowsForEvent } from '@/lib/flows/event-start';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { isWebhookEvent } from '@/lib/webhooks/events';
import { exitSequencesFor } from '@/lib/sequences/subscriptions';
import type { AutomationTriggerType } from '@/types';
import { getDomainEvent, type DomainEventRow } from './store';
import { triggerForEvent } from './types';
import { paymentLinkPaidData, webhookDataForEvent } from './webhook-data';
import { eventVars } from './vars';

export { eventVars } from './vars';

export const EVENTS_DISPATCH_JOB = 'events.dispatch';

/**
 * The 'events.dispatch' job: one per domain event, queued in the transaction that recorded it.
 *
 * Fans the event out to rules, flows and outbound webhooks. Each target runs once through an
 * outbound intent keyed by the event id (dispatchOnce), so a retried job never fires a rule,
 * starts a flow or queues a webhook twice; a target whose outcome was lost mid-way is left for
 * reconciliation (the "Needs review" list) instead of being repeated.
 */
export async function handleEventDispatchJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const eventId = typeof payload.eventId === 'string' ? payload.eventId : '';
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw new Error('Invalid event dispatch payload');
  const loaded = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const event = await getDomainEvent(tx, accountId, eventId);
    if (!event) return null;
    // Sequences set to "Exit when bought" stop for the buyer (idempotent, so a retried job is harmless).
    if (event.contact_id && (event.type === 'order.paid' || (event.type === 'order.created' && event.data.status === 'paid')))
      await exitSequencesFor(tx, { accountId, contactId: event.contact_id, reason: 'bought', at: event.occurred_at });
    const conversationId = await whatsappConversation(tx, accountId, event);
    return {
      event, conversationId,
      webhook: isWebhookEvent(event.type) ? await webhookDataForEvent(tx, event) : null,
      linkPaid: await paymentLinkPaidData(tx, event),
    };
  }, getWorkerPrisma());
  if (!loaded) return;
  const { event, conversationId, webhook, linkPaid } = loaded;
  const key = `domain-event:${event.id}`;

  if (event.contact_id) {
    const contactId = event.contact_id;
    await dispatchOnce(accountId, `${key}:rules`, async () => ({
      matched: await runAutomationsForTrigger({
        accountId,
        // Event triggers send over WhatsApp, like the appointment triggers before them.
        channel: 'whatsapp',
        triggerType: triggerForEvent(event.type) as AutomationTriggerType,
        contactId,
        context: {
          ...(typeof event.data.service_id === 'string' ? { service_id: event.data.service_id } : {}),
          ...(conversationId ? { conversation_id: conversationId } : {}),
          event: { type: event.type, data: event.data },
          vars: eventVars(event),
        },
      }),
    }));
    await dispatchOnce(accountId, `${key}:flows`, async () => ({
      started: await startFlowsForEvent({ accountId, event, conversationId }),
    }));
  }

  const db = createAdminClient({ accountId, role: 'owner' });
  if (webhook && isWebhookEvent(event.type)) {
    const name = event.type;
    await dispatchOnce(accountId, `${key}:webhook`, async () => {
      await dispatchWebhookEvent(db, accountId, name, webhook);
      return { queued: true };
    });
  }
  if (linkPaid) {
    await dispatchOnce(accountId, `${key}:payment_link.paid`, async () => {
      await dispatchWebhookEvent(db, accountId, 'payment_link.paid', linkPaid);
      return { queued: true };
    });
  }
}

/** The event's own conversation when it names a WhatsApp one, else the contact's latest WhatsApp conversation. */
async function whatsappConversation(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0], accountId: string, event: DomainEventRow,
): Promise<string | null> {
  if (!event.contact_id) return null;
  const named = typeof event.data.conversation_id === 'string' ? event.data.conversation_id : null;
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM conversations
    WHERE account_id=${accountId}::uuid AND contact_id=${event.contact_id}::uuid AND channel='whatsapp'
    ORDER BY (id::text = ${named ?? ''}) DESC, updated_at DESC LIMIT 1`;
  return row?.id ?? null;
}
