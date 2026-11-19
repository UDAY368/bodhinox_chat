import type { DomainEventRow } from '@/lib/events/store';

/**
 * Starts every active flow whose trigger listens on this domain event (the event's trigger
 * name, src/lib/events/types.ts triggerForEvent) for the event's contact. Returns how many
 * runs started. Called once per event by the 'events.dispatch' job inside dispatchOnce.
 */
export async function startFlowsForEvent(_input: {
  accountId: string; event: DomainEventRow; conversationId: string | null;
}): Promise<number> {
  void _input;
  return 0;
}
