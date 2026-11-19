import type { TenantTransaction } from '@/lib/db/tenant';
import {
  DOMAIN_EVENT_DATA_MAX_BYTES, DOMAIN_SUBJECT_KINDS, isDomainEventType,
  type DomainEventData, type DomainEventInput,
} from './types';

/**
 * Record a domain event inside the caller's transaction (standardisation plan section 5).
 *
 * The event row and its 'events.dispatch' job commit or roll back with the change itself, so
 * nothing downstream (rules, flows, webhooks) ever sees a change that did not happen, and a
 * committed change is never missed. Call it from inside withTenant, after the write it describes.
 *
 * Returns the event id and whether it was new: with a dedupeKey, a second call for the same key
 * in the same workspace records nothing and returns the existing id.
 *
 * Orders (created, paid, shipped, delivered), returns received, payments captured, deal stage
 * moves and form answers are emitted by database triggers (migration 20261205000000) and need
 * no call. emit_domain_event() in that migration is the SQL twin of this function.
 */
export async function emitDomainEvent(tx: TenantTransaction, input: DomainEventInput): Promise<{ id: string; created: boolean }> {
  assertEvent(input);
  const data = JSON.stringify(input.data);
  const rows = await tx.$queryRaw<{ id: string; created: boolean }[]>`
    SELECT event_id::text AS id, created FROM emit_domain_event(
      ${input.accountId}::uuid, ${input.type}, ${input.subject.kind}, ${input.subject.id}::uuid,
      ${input.contactId ?? null}::uuid, ${data}::jsonb, ${input.dedupeKey ?? null})`;
  return rows[0];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Programming errors only: a bad call fails loudly in tests instead of writing a malformed event. */
export function assertEvent(input: DomainEventInput): void {
  if (!uuid.test(input.accountId) || !uuid.test(input.subject.id) || (input.contactId && !uuid.test(input.contactId))) {
    throw new Error('Invalid domain event identity');
  }
  if (!isDomainEventType(input.type)) throw new Error('Unknown domain event type');
  if (!(DOMAIN_SUBJECT_KINDS as readonly string[]).includes(input.subject.kind)) throw new Error('Unknown domain event subject');
  if (input.dedupeKey !== undefined && (!input.dedupeKey || input.dedupeKey.length > 200)) throw new Error('Invalid domain event dedupe key');
  assertFlatData(input.data);
}

function assertFlatData(data: DomainEventData): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Domain event data must be an object');
  for (const value of Object.values(data)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error('Domain event data holds scalars only');
    }
  }
  if (Buffer.byteLength(JSON.stringify(data)) > DOMAIN_EVENT_DATA_MAX_BYTES) throw new Error('Domain event data too large');
}
