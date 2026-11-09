import { Prisma } from '@prisma/client';
import type { DataClient } from '@/lib/data/types';
import { resolveAudienceContacts } from '@/lib/broadcast-audience';
import {
  MAX_SCHEDULED_CONTACTS,
  parseScheduledAudience,
  scheduleNeedsContact,
  stepsSendMessages,
  type ScheduledStep,
} from '@/lib/automations/scheduled-contract';
import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import {
  PlanLimitError,
  requireFeature,
  requireWithinLimit,
} from '@/lib/billing/entitlements';
import { requireCampaignSendRoom } from '@/lib/billing/limits';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchOnce } from './dispatch';
import { enqueueJob } from './queue';
import { pickContactConversationId } from '@/lib/whatsapp/contact-conversation';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { loadSegmentFilter } from '@/lib/audience/segments';
import { AudienceFilterError, assertFilterReferences, compileAudienceFilter } from '@/lib/audience/filter';
import type { Contact } from '@/types';

type ScheduledAutomation = {
  id: string;
  user_id?: string;
  trigger_config: Record<string, unknown>;
};
async function loadSteps(db: DataClient, id: string): Promise<ScheduledStep[]> {
  const { data, error } = await db
    .from('automation_steps')
    .select('step_type,step_config')
    .eq('automation_id', id)
    .limit(1000);
  if (error) throw new Error('Could not load scheduled automation steps');
  return data ?? [];
}
async function requireAudienceReferences(
  db: DataClient,
  audience: ReturnType<typeof parseScheduledAudience>
) {
  const tagIds = [
    ...new Set([...(audience.tagIds ?? []), ...(audience.excludeTagIds ?? [])]),
  ];
  if (tagIds.length) {
    const { data, error } = await db.from('tags').select('id').in('id', tagIds);
    if (error || data?.length !== tagIds.length)
      throw new Error('Scheduled recipient tags must belong to this workspace');
  }
  if (audience.customField) {
    const { data, error } = await db
      .from('custom_fields')
      .select('id')
      .eq('id', audience.customField.fieldId)
      .maybeSingle();
    if (error || !data)
      throw new Error(
        'Scheduled recipient custom field must belong to this workspace'
      );
  }
}
/**
 * A saved segment's members now: its filter is read at each occurrence, so
 * membership is dynamic. A segment archived by a plan downgrade, or whose
 * filter names a deleted tag, list, campaign or custom field, is refused (as
 * for campaigns: a has_none on a deleted tag would match everyone); a
 * retargeting condition the plan no longer allows throws PlanLimitError.
 * Opted-out and blocked contacts, and with onlyNewFor the contacts that
 * automation already ran for, are left out in SQL before the
 * MAX_SCHEDULED_CONTACTS cap, so the cap counts real recipients only; more
 * than that is refused, never truncated.
 */
export async function segmentRecipients(accountId: string, segmentId: string,
  options: { onlyNewFor?: string } = {}): Promise<Pick<Contact, 'id'>[]> {
  const rows = await withTenant({ accountId }, async (tx) => {
    let filter;
    try {
      filter = await loadSegmentFilter(tx, accountId, segmentId, { lock: true });
      await assertFilterReferences(tx, accountId, filter);
    } catch (error) {
      if (!(error instanceof AudienceFilterError)) throw error;
      throw new Error('Scheduled recipient segment must belong to this workspace and be active');
    }
    // once_per_contact: served by automation_logs_automation_contact_idx.
    const notYetRun = options.onlyNewFor
      ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM automation_logs l WHERE l.account_id=${accountId}::uuid
          AND l.automation_id=${options.onlyNewFor}::uuid AND l.contact_id=c.id)`
      : Prisma.empty;
    return tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT c.id::text AS id FROM contacts c
      WHERE ${compileAudienceFilter(accountId, filter)} AND c.opted_out_at IS NULL AND c.blocked_at IS NULL ${notYetRun}
      ORDER BY c.created_at, c.id LIMIT ${MAX_SCHEDULED_CONTACTS + 1}`);
  }, getWorkerPrisma());
  if (rows.length > MAX_SCHEDULED_CONTACTS)
    throw new Error(`Scheduled audience exceeds the ${MAX_SCHEDULED_CONTACTS}-row limit; use a narrower recipient filter`);
  return rows.map((row) => ({ id: String(row.id) }));
}

/** Contacts this automation has already run for (once_per_contact); uses automation_logs_automation_contact_idx. */
export async function contactsAlreadyRun(accountId: string, automationId: string, contactIds: readonly string[]): Promise<Set<string>> {
  if (!contactIds.length) return new Set();
  const rows = await withTenant({ accountId }, (tx) => tx.$queryRaw<{ contact_id: string }[]>`
    SELECT DISTINCT contact_id::text AS contact_id FROM automation_logs
    WHERE account_id=${accountId}::uuid AND automation_id=${automationId}::uuid AND contact_id = ANY(${[...contactIds]}::uuid[])`,
  getWorkerPrisma());
  return new Set(rows.map((row) => row.contact_id));
}

/** Turn a schedule off when its plan no longer allows it, with a failed log row saying why. */
async function pauseForPlan(db: DataClient, accountId: string, automationId: string, reason: string) {
  const { data: paused, error } = await db
    .from('automations')
    .update({ is_active: false })
    .eq('id', automationId)
    .eq('is_active', true)
    .select('id,user_id');
  if (error) throw new Error('Could not pause scheduled automation');
  // Another worker already paused it: one log row is enough.
  const row = paused?.[0];
  if (!row) return;
  const log = await db.from('automation_logs').insert({
    automation_id: automationId,
    account_id: accountId,
    user_id: row.user_id,
    trigger_event: 'time_based',
    steps_executed: [],
    status: 'failed',
    error_message: `Schedule turned off: ${reason}`,
  });
  if (log.error) throw new Error('Could not log paused scheduled automation');
}
/** Resolve once for this occurrence, then persist a stable tenant/contact/slot dispatch identity. */
export async function queueScheduledOccurrence(
  db: DataClient,
  accountId: string,
  automation: ScheduledAutomation,
  slot: string,
  assertLease: () => void
) {
  const config = automation.trigger_config ?? {};
  if (config.audience === undefined) {
    if (scheduleNeedsContact(await loadSteps(db, automation.id)))
      throw new Error(
        'Scheduled contact actions require explicit recipients; choose all contacts or a recipient filter'
      );
    assertLease();
    await enqueueJob(
      'automation.trigger',
      { automationId: automation.id, slot },
      {
        tenantId: accountId,
        dedupeKey: `trigger:${automation.id}:${slot}:account`,
      }
    );
    return;
  }
  const audience = parseScheduledAudience(config.audience);
  const oncePerContact = config.once_per_contact === true;
  let contacts: Pick<Contact, 'id'>[];
  if (audience.type === 'segment') {
    try {
      contacts = await segmentRecipients(accountId, audience.segmentId!, oncePerContact ? { onlyNewFor: automation.id } : {});
    } catch (error) {
      // A retargeting segment after a downgrade: turn the schedule off once, not fail every slot.
      if (!(error instanceof PlanLimitError)) throw error;
      await pauseForPlan(db, accountId, automation.id, error.message);
      return;
    }
  } else {
    await requireAudienceReferences(db, audience);
    contacts = await resolveAudienceContacts(
      db,
      audience,
      async () => {
        throw new Error('CSV recipients are unsupported for schedules');
      },
      { maxRows: MAX_SCHEDULED_CONTACTS }
    );
  }
  // Segments already left out contacts that ran (in SQL, before the cap).
  if (oncePerContact && audience.type !== 'segment') {
    const done = await contactsAlreadyRun(accountId, automation.id, contacts.map((c) => c.id));
    contacts = contacts.filter((c) => !done.has(c.id));
  }
  if (stepsSendMessages(await loadSteps(db, automation.id))) {
    // A schedule that messages contacts is a recurring campaign. The plan can
    // change after activation, so it is checked per occurrence; a refusal
    // turns the automation off and logs why instead of retrying every slot.
    try {
      await withTenant(
        { accountId },
        async (tx) => {
          await requireFeature(tx, accountId, 'campaign_scheduling');
          await requireWithinLimit(tx, accountId, 'campaign_recipients', contacts.length);
          await requireCampaignSendRoom(tx, accountId, contacts.length);
        },
        getWorkerPrisma()
      );
    } catch (error) {
      if (!(error instanceof PlanLimitError)) throw error;
      await pauseForPlan(db, accountId, automation.id, error.message);
      return;
    }
  }
  for (const contact of contacts) {
    assertLease();
    await enqueueJob(
      'automation.trigger',
      { automationId: automation.id, contactId: contact.id, slot },
      {
        tenantId: accountId,
        dedupeKey: `trigger:${automation.id}:${slot}:${contact.id}`,
      }
    );
  }
}

/** The contact's conversation a scheduled automation acts on (one per number; see pickContactConversationId). */
async function findContactConversationId(db: DataClient, accountId: string, contactId: string) {
  try {
    return await pickContactConversationId(db, accountId, contactId);
  } catch {
    throw new Error('Could not resolve scheduled conversation');
  }
}

/** Entire executions are fenced too: retry cannot mint a fresh log and resend completed steps. */
export async function executeScheduledOccurrence(
  db: DataClient,
  accountId: string,
  automationId: string,
  slot: string,
  contactId: string | undefined,
  assertLease: () => void
) {
  if (!Number.isFinite(Date.parse(slot)))
    throw new Error('Invalid scheduled occurrence');
  const { data: automation, error } = await db
    .from('automations')
    .select('id,user_id,is_active,trigger_type,trigger_config')
    .eq('id', automationId)
    .maybeSingle();
  if (error) throw new Error('Could not load scheduled automation');
  if (
    !automation ||
    !automation.is_active ||
    automation.trigger_type !== 'time_based'
  )
    return;
  // once_per_contact: an earlier occurrence may have run for this contact since this one was queued.
  if (contactId && (automation.trigger_config as Record<string, unknown> | null)?.once_per_contact === true &&
    (await contactsAlreadyRun(accountId, automationId, [contactId])).size)
    return;
  const steps = await loadSteps(db, automationId);
  if (!contactId && scheduleNeedsContact(steps))
    throw new Error('Scheduled contact actions require explicit recipients');
  let conversationId: string | undefined;
  if (contactId) {
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('id,phone,wa_user_id')
      .eq('id', contactId)
      .maybeSingle();
    if (contactError || !contact)
      throw new Error('Scheduled contact no longer belongs to this workspace');
    if (
      steps.some((step) =>
        [
          'send_message',
          'send_template',
          'send_buttons',
          'send_list',
          'assign_conversation',
          'close_conversation',
        ].includes(step.step_type)
      )
    ) {
      conversationId = await findContactConversationId(db, accountId, contactId);
      // A contact with no WhatsApp address (Instagram-only, Phase 11) gets no
      // WhatsApp conversation: the run goes ahead without one, so its send
      // steps fail the normal way and leave no empty thread behind.
      if (!conversationId && resolveContactSendTarget(contact)) {
        // One WhatsApp conversation per (contact, number); the insert trigger
        // fills whatsapp_config_id with the workspace default. The key is a
        // partial unique index (WhatsApp rows only, Phase 11), which ON CONFLICT
        // cannot name without its predicate, so a racing insert's unique
        // violation is read as "already there" and re-resolved below.
        const inserted = await db
          .from('conversations')
          .insert({
            account_id: accountId,
            user_id: automation.user_id,
            contact_id: contactId,
            status: 'open',
          });
        if (inserted.error && !isUniqueViolation(inserted.error))
          throw new Error('Could not create scheduled conversation');
        conversationId = await findContactConversationId(db, accountId, contactId);
        if (!conversationId)
          throw new Error('Could not resolve scheduled conversation');
      }
    }
  }
  assertLease();
  // once_per_contact fences per contact, not per slot: two occurrences for
  // the same contact running at once (a backlog on several workers) share one
  // intent, so the second never runs the automation again.
  const oncePerContact = contactId !== undefined
    && (automation.trigger_config as Record<string, unknown> | null)?.once_per_contact === true;
  await dispatchOnce(
    accountId,
    oncePerContact ? `scheduled-once:${automationId}:${contactId}` : `scheduled:${automationId}:${slot}:${contactId ?? 'account'}`,
    async () => {
      assertLease();
      await runAutomationsForTrigger({
        accountId,
        automationId,
        triggerType: 'time_based',
        contactId,
        context: {
          conversation_id: conversationId,
          vars: { scheduled_at: slot },
        },
      });
      return { completed: true };
    }
  );
}
