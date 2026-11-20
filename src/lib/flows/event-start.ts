import type { DomainEventRow } from '@/lib/events/store';
import { eventFiltersMatch } from '@/lib/events/trigger-filters';
import { triggerForEvent } from '@/lib/events/types';
import { eventVars } from '@/lib/events/vars';
import { databaseAdmin } from './admin-client';
import { effectiveFlow, loadPublishedVersions } from './versions';
import { effectiveTriggers } from './flow-triggers';
import type { FlowRow } from './types';

/**
 * Starts every live flow whose triggers (primary or extra) listen on this domain event (the
 * event's trigger name, src/lib/events/types.ts triggerForEvent) and whose filters match its
 * data, for the event's contact on its WhatsApp conversation. Returns how many runs started.
 *
 * Called once per event by the 'events.dispatch' job inside dispatchOnce. Each flow starts at
 * most once per event: a flow listening twice is tried once, and the start's inbound id is
 * `event:<event id>:<flow id>`, so a retried start finds the run it started (startFlowById
 * answers "conflict") instead of starting another. One run per conversation still holds: while
 * a run is active, a later match answers "conflict" and does not start.
 *
 * Like a tag start this is business-initiated: no conversation, a blocked contact or one who
 * sent STOP gets no flow. Live flows only, matched on their published version.
 */
export async function startFlowsForEvent(input: {
  accountId: string; event: DomainEventRow; conversationId: string | null;
}): Promise<number> {
  const { accountId, event, conversationId } = input;
  if (!event.contact_id || !conversationId) return 0;
  const db = databaseAdmin();
  const [conversation, contact] = await Promise.all([
    db.from('conversations').select('id, channel, whatsapp_config_id').eq('account_id', accountId)
      .eq('id', conversationId).eq('contact_id', event.contact_id).maybeSingle(),
    db.from('contacts').select('id, blocked_at, opted_out_at').eq('account_id', accountId).eq('id', event.contact_id).maybeSingle(),
  ]);
  if (conversation.error || contact.error) throw new Error('Event flow ownership lookup failed');
  const row = conversation.data as { id: string; channel?: string | null; whatsapp_config_id?: string | null } | null;
  const person = contact.data as { blocked_at?: string | null; opted_out_at?: string | null } | null;
  if (!row || row.channel === 'instagram' || !person || person.blocked_at || person.opted_out_at) return 0;

  const trigger = triggerForEvent(event.type);
  const active = await db.from('flows').select('*').eq('account_id', accountId).eq('status', 'active')
    .order('created_at', { ascending: true });
  if (active.error) throw new Error('Event flow lookup failed');
  const live = ((active.data ?? []) as FlowRow[]).filter((f) => f.account_id === accountId && f.status === 'active' && f.published_version_id);
  if (!live.length) return 0;
  const versions = await loadPublishedVersions(accountId, live.map((f) => f.published_version_id as string));
  // Loaded on use: the engine imports the event feed's neighbours through the tag writer.
  const { flowListensOnConversation, startFlowById } = await import('./engine');
  const target = { channel: 'whatsapp' as const, whatsappConfigId: row.whatsapp_config_id ?? null };
  const matches = live.flatMap((f) => {
    const version = versions.get(f.published_version_id as string);
    if (!version || version.flow_id !== f.id) return [];
    const flow = effectiveFlow(f, version);
    if (!flowListensOnConversation(flow, target)) return [];
    // Each flow once, however many of its triggers match.
    return effectiveTriggers(flow).some((t) => t.trigger_type === trigger && eventFiltersMatch(trigger, t.config, event.data))
      ? [flow] : [];
  });

  const vars = eventVars(event);
  let started = 0;
  for (const flow of matches) {
    const result = await startFlowById({
      accountId,
      userId: flow.user_id,
      contactId: event.contact_id,
      conversationId: row.id,
      flowId: flow.id,
      // A synthetic start event: no customer text.
      message: { kind: 'text', text: '', meta_message_id: `event:${event.id}:${flow.id}` },
      vars,
    });
    if (result.outcome === 'started') started += 1;
  }
  return started;
}
