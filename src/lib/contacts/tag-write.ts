import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { DataClient } from '@/lib/data/types';
import { getT } from '@/lib/i18n/translate';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { defaultMaxAttempts } from '@/lib/jobs/retry';

const t = getT('LibErrors');

export class ContactTagWriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ContactTagWriteError';
    this.status = status;
  }
}

interface ContactTagWriteInput {
  accountId: string;
  contactId: string;
  tagId: string;
}

async function assertContactAndTagOwnership(
  db: DataClient,
  input: ContactTagWriteInput
): Promise<void> {
  const [contactResult, tagResult] = await Promise.all([
    db
      .from('contacts')
      .select('id')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
    db
      .from('tags')
      .select('id')
      .eq('id', input.tagId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
  ]);

  if (contactResult.error || tagResult.error) {
    throw new ContactTagWriteError(t('tags.verifyFailed'));
  }
  if (!contactResult.data) {
    throw new ContactTagWriteError(t('tags.contactNotFound'), 404);
  }
  if (!tagResult.data) {
    throw new ContactTagWriteError(t('tags.tagNotFound'), 404);
  }
}

/**
 * Add a tag exactly once. The unique constraint on
 * (contact_id, tag_id) is the concurrency-safe source of truth: a
 * duplicate insert is a no-op and must not emit a tag_added event.
 */
export async function addContactTagIfAbsent(
  db: DataClient,
  input: ContactTagWriteInput
): Promise<boolean> {
  await assertContactAndTagOwnership(db, input);

  const { error } = await db
    .from('contact_tags')
    .insert({ contact_id: input.contactId, tag_id: input.tagId })
    .select('id')
    .maybeSingle();

  if (error?.code === '23505') return false;
  if (error) {
    throw new ContactTagWriteError(
      t('tags.addFailed', { message: error.message })
    );
  }
  return true;
}

/**
 * Removes a tag. Stage 5: when a row was really removed, the tag_removed
 * event for every matching active automation is queued in the same
 * transaction as the delete (queueContactEvent), so the event is never lost
 * and never queued for a delete that rolled back. `eventId` carries the
 * originating event through an automation's own writes (the loop guard);
 * omitted, the removal is a new event. Returns whether a tag was removed.
 */
export async function removeContactTag(
  db: DataClient,
  input: ContactTagWriteInput & { eventId?: string }
): Promise<boolean> {
  await assertContactAndTagOwnership(db, input);

  try {
    return await withTenant({ accountId: input.accountId, role: 'owner' }, async (tx) => {
      const removed = await tx.$queryRaw<{ id: string }[]>`DELETE FROM contact_tags
        WHERE account_id=${input.accountId}::uuid AND contact_id=${input.contactId}::uuid AND tag_id=${input.tagId}::uuid
        RETURNING id::text AS id`;
      if (!removed.length) return false;
      await queueContactEvent(tx, {
        accountId: input.accountId, contactId: input.contactId, eventId: input.eventId,
        event: { type: 'tag_removed', tagId: input.tagId },
      });
      return true;
    }, getWorkerPrisma());
  } catch {
    // Ids only: the driver message can carry query values.
    throw new ContactTagWriteError(t('tags.removeFailed', { message: 'database error' }));
  }
}

// ------------------------------------------------------------ contact events (Stage 5)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A contact event an automation can start on. Presence, never values: payloads carry no customer content. */
export type ContactEvent =
  | { type: 'tag_removed'; tagId: string }
  | { type: 'field_changed'; field: string; hadValue: boolean; hasValue: boolean };

/** The automation.trigger job slot of a contact event: `event:<event id>`. */
export const CONTACT_EVENT_SLOT = /^event:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** The job dedupe key: at most one run per automation, contact and event id. */
export const contactEventKey = (automationId: string, contactId: string, eventId: string) =>
  `contact-event:${automationId}:${contactId}:${eventId}`;

/**
 * Queues `event` for every active automation of the account whose trigger
 * matches it (tag_removed on that tag, field_changed on that field), inside
 * the caller's transaction, as automation.trigger jobs keyed by automation,
 * contact and event id. The same event id never queues an automation twice,
 * so an automation whose own step removes the tag or writes the field it
 * listens to (which passes its event id on) cannot start itself again. A
 * workspace without such automations queues nothing. Returns the event id.
 */
export async function queueContactEvent(tx: TenantTransaction, input: {
  accountId: string; contactId: string; eventId?: string; event: ContactEvent;
}): Promise<string> {
  const eventId = input.eventId && UUID.test(input.eventId) ? input.eventId.toLowerCase() : randomUUID();
  const { event } = input;
  const match = event.type === 'tag_removed'
    ? Prisma.sql`a.trigger_type='tag_removed' AND a.trigger_config->>'tag_id' = ${event.tagId}`
    : Prisma.sql`a.trigger_type='field_changed' AND a.trigger_config->>'field' = ${event.field}`;
  const summary = event.type === 'tag_removed'
    ? { type: event.type, tag_id: event.tagId }
    : { type: event.type, field: event.field, had_value: event.hadValue, has_value: event.hasValue };
  await tx.$executeRaw(Prisma.sql`INSERT INTO jobs(type, tenant_id, payload, dedupe_key, max_attempts)
    SELECT 'automation.trigger', a.account_id,
      jsonb_build_object('automationId', a.id::text, 'contactId', ${input.contactId}::text,
        'slot', ${`event:${eventId}`}::text, 'event', ${JSON.stringify(summary)}::jsonb),
      'contact-event:' || a.id::text || ':' || ${input.contactId}::text || ':' || ${eventId}::text,
      ${defaultMaxAttempts('automation.trigger')}
    FROM automations a
    WHERE a.account_id=${input.accountId}::uuid AND a.is_active AND a.archived_at IS NULL AND ${match}
    ON CONFLICT (dedupe_key) DO NOTHING`);
  return eventId;
}
