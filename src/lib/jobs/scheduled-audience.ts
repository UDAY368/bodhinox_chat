import { Prisma } from '@prisma/client';
import type { DataClient } from '@/lib/data/types';
import {
  MAX_SCHEDULED_CONTACTS,
  SCHEDULED_PAGE_SIZE,
  parseScheduledAudience,
  scheduleNeedsContact,
  stepsSendMessages,
  type ScheduledAudience,
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
import { runAutomationsForTrigger, runContactEventAutomation } from '@/lib/automations/engine';
import { CONTACT_EVENT_SLOT } from '@/lib/contacts/tag-write';
import { instagramScheduledAutomationsEnabled } from '@/lib/instagram/config';
import { dispatchOnce } from './dispatch';
import { enqueueJob } from './queue';
import { pickContactConversationId } from '@/lib/whatsapp/contact-conversation';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { loadSegmentFilter } from '@/lib/audience/segments';
import { AudienceFilterError, assertFilterReferences, compileAudienceFilter } from '@/lib/audience/filter';
import { notifyAutomationNotice } from '@/lib/notifications/emit';
import type { Contact } from '@/types';

type ScheduledAutomation = {
  id: string;
  user_id?: string;
  trigger_config: Record<string, unknown>;
  /** The automation's channel when the caller read it; otherwise it is looked up. */
  channel?: string | null;
};

/** Whether a schedule belongs to the Instagram section (Stage 5); anything else is WhatsApp, as before. */
async function scheduleOnInstagram(db: DataClient, automation: ScheduledAutomation): Promise<boolean> {
  if (automation.channel !== undefined) return automation.channel === 'instagram';
  const { data, error } = await db.from('automations').select('channel').eq('id', automation.id).maybeSingle();
  if (error) throw new Error('Could not load scheduled automation channel');
  return (data as { channel?: string | null } | null)?.channel === 'instagram';
}

/**
 * Stage 5: an Instagram schedule reaches only contacts with an Instagram
 * conversation who have not unsubscribed on Instagram (the engine re-checks
 * both, and the 24-hour window before every send).
 */
const instagramRecipients = (accountId: string) => Prisma.sql`c.instagram_opted_out_at IS NULL
  AND EXISTS(SELECT 1 FROM conversations v WHERE v.account_id=${accountId}::uuid AND v.contact_id=c.id AND v.channel='instagram')`;
/**
 * A scheduled occurrence that cannot run as configured (too many recipients,
 * a foreign or deleted reference, no recipients chosen). Retrying the same
 * minute cannot fix it, so the tick logs it and goes on with the others.
 */
export class ScheduledAudienceError extends Error {}
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
    if (error) throw new Error('Scheduled recipient tag lookup failed');
    if (data?.length !== tagIds.length)
      throw new ScheduledAudienceError('Scheduled recipient tags must belong to this workspace');
  }
  if (audience.customField) {
    const { data, error } = await db
      .from('custom_fields')
      .select('id')
      .eq('id', audience.customField.fieldId)
      .maybeSingle();
    if (error) throw new Error('Scheduled recipient custom field lookup failed');
    if (!data)
      throw new ScheduledAudienceError(
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
 * The members are read in pages like every scheduled audience (pagedRecipients).
 */
export async function segmentRecipients(accountId: string, segmentId: string,
  options: { onlyNewFor?: string } = {}): Promise<Pick<Contact, 'id'>[]> {
  const condition = await withTenant({ accountId }, async (tx) => {
    try {
      const filter = await loadSegmentFilter(tx, accountId, segmentId, { lock: true });
      await assertFilterReferences(tx, accountId, filter);
      return compileAudienceFilter(accountId, filter);
    } catch (error) {
      if (!(error instanceof AudienceFilterError)) throw error;
      throw new ScheduledAudienceError('Scheduled recipient segment must belong to this workspace and be active');
    }
  }, getWorkerPrisma());
  return pagedRecipients(accountId, condition, options);
}

const tagged = (accountId: string, tagIds: readonly string[]) =>
  Prisma.sql`EXISTS(SELECT 1 FROM contact_tags t WHERE t.account_id=${accountId}::uuid AND t.contact_id=c.id
    AND t.tag_id = ANY(${[...tagIds]}::uuid[]))`;

/** An all / tags / custom-field schedule audience as a condition over `contacts c` (the broadcast-audience matches). */
export function audienceCondition(accountId: string, audience: ScheduledAudience): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`c.account_id=${accountId}::uuid`];
  if (audience.type === 'tags') parts.push(tagged(accountId, audience.tagIds ?? []));
  if (audience.type === 'custom_field' && audience.customField) {
    const { fieldId, operator, value } = audience.customField;
    const match = operator === 'is' ? Prisma.sql`v.value = ${value}`
      : operator === 'is_not' ? Prisma.sql`v.value <> ${value}`
        : Prisma.sql`v.value ILIKE ${`%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`;
    parts.push(Prisma.sql`EXISTS(SELECT 1 FROM contact_custom_values v WHERE v.account_id=${accountId}::uuid
      AND v.contact_id=c.id AND v.custom_field_id=${fieldId}::uuid AND ${match})`);
  }
  if (audience.excludeTagIds?.length) parts.push(Prisma.sql`NOT ${tagged(accountId, audience.excludeTagIds)}`);
  return Prisma.join(parts, ' AND ');
}

/**
 * The recipients of one occurrence, read in pages of SCHEDULED_PAGE_SIZE
 * (keyset on id, one short transaction per page). Opted-out and blocked
 * contacts, and with onlyNewFor the contacts that automation already ran for,
 * are left out in SQL before the MAX_SCHEDULED_CONTACTS cap, so the cap counts
 * real recipients only; more than that is refused, never truncated.
 */
async function pagedRecipients(accountId: string, condition: Prisma.Sql,
  options: { onlyNewFor?: string }): Promise<Pick<Contact, 'id'>[]> {
  // once_per_contact: served by automation_logs_automation_contact_idx.
  const notYetRun = options.onlyNewFor
    ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM automation_logs l WHERE l.account_id=${accountId}::uuid
        AND l.automation_id=${options.onlyNewFor}::uuid AND l.contact_id=c.id)`
    : Prisma.empty;
  const ids: string[] = [];
  for (;;) {
    const after = ids.length ? Prisma.sql`AND c.id > ${ids[ids.length - 1]}::uuid` : Prisma.empty;
    const page = await withTenant({ accountId }, (tx) => tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT c.id::text AS id FROM contacts c
      WHERE ${condition} AND c.opted_out_at IS NULL AND c.blocked_at IS NULL ${notYetRun} ${after}
      ORDER BY c.id LIMIT ${SCHEDULED_PAGE_SIZE}`), getWorkerPrisma());
    ids.push(...page.map((row) => String(row.id)));
    if (ids.length > MAX_SCHEDULED_CONTACTS)
      throw new ScheduledAudienceError(`Scheduled audience exceeds the ${MAX_SCHEDULED_CONTACTS}-contact limit; use a narrower recipient filter`);
    if (page.length < SCHEDULED_PAGE_SIZE) return ids.map((id) => ({ id }));
  }
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

/**
 * One occurrence that could not run as configured (ScheduledAudienceError):
 * a failed log row and an in-app notice to owners and admins, once per slot
 * (a retried tick adds neither again). The schedule stays on; the next
 * occurrence tries again once the recipients are narrowed or fixed.
 */
export async function recordSkippedOccurrence(
  db: DataClient,
  accountId: string,
  automation: ScheduledAutomation & { name?: string | null },
  slot: string,
  reason: string
) {
  const message = `Scheduled run at ${slot} skipped: ${reason}`;
  const { data: logged, error } = await db
    .from('automation_logs')
    .select('id')
    .eq('automation_id', automation.id)
    .eq('status', 'failed')
    .eq('error_message', message)
    .limit(1);
  if (error) throw new Error('Could not read scheduled automation logs');
  if (!logged?.length) {
    const log = await db.from('automation_logs').insert({
      automation_id: automation.id,
      account_id: accountId,
      user_id: automation.user_id,
      trigger_event: 'time_based',
      steps_executed: [],
      status: 'failed',
      error_message: message,
    });
    if (log.error) throw new Error('Could not log skipped scheduled automation');
  }
  const name = typeof automation.name === 'string' && automation.name.trim()
    ? automation.name.trim().slice(0, 100) : 'A scheduled automation';
  try {
    await notifyAutomationNotice({
      accountId,
      automationId: automation.id,
      audience: 'admins',
      title: `Scheduled automation "${name}" did not run: ${reason}`,
      dedupeKey: `schedule-skipped:${automation.id}:${slot}`,
    });
  } catch {
    // The log row is the record; a lost notice must not fail the tick.
    console.error('[automations] skipped-schedule notice failed', { automationId: automation.id });
  }
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
  // Stage 5: a schedule on Instagram runs only while INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED is on.
  const instagram = await scheduleOnInstagram(db, automation);
  if (instagram && !instagramScheduledAutomationsEnabled()) return;
  if (config.audience === undefined) {
    if (scheduleNeedsContact(await loadSteps(db, automation.id)))
      throw new ScheduledAudienceError(
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
  let audience: ScheduledAudience;
  try {
    audience = parseScheduledAudience(config.audience);
  } catch (error) {
    throw new ScheduledAudienceError(error instanceof Error ? error.message : 'Invalid scheduled recipients');
  }
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
    const condition = audienceCondition(accountId, audience);
    contacts = await pagedRecipients(accountId,
      instagram ? Prisma.sql`${condition} AND ${instagramRecipients(accountId)}` : condition,
      oncePerContact ? { onlyNewFor: automation.id } : {});
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

/**
 * One Instagram schedule occurrence (Stage 5). Instagram has no business-
 * initiated messages, so it never creates a conversation: the run uses the
 * contact's latest Instagram conversation (the engine resolves it), and each
 * customer send re-checks the 24-hour window, ending the run as window_closed
 * when it has closed. A contact unsubscribed on Instagram is skipped by the
 * engine. Fenced like the WhatsApp occurrences: one run per slot and contact.
 */
async function runInstagramOccurrence(accountId: string, automationId: string, key: string, slot: string,
  contactId: string | undefined, assertLease: () => void) {
  assertLease();
  await dispatchOnce(accountId, key, async () => {
    assertLease();
    await runAutomationsForTrigger({
      accountId,
      channel: 'instagram',
      automationId,
      triggerType: 'time_based',
      contactId,
      context: { vars: { scheduled_at: slot } },
    });
    return { completed: true };
  });
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
  // Stage 5: a contact event (tag_removed, field_changed) rides the same job
  // type with the slot `event:<event id>` (src/lib/contacts/tag-write.ts).
  const contactEvent = CONTACT_EVENT_SLOT.exec(slot);
  if (contactEvent) {
    if (!contactId) throw new Error('Invalid contact event occurrence');
    assertLease();
    await runContactEventAutomation({ accountId, automationId, contactId, eventId: contactEvent[1].toLowerCase() });
    return;
  }
  if (!Number.isFinite(Date.parse(slot)))
    throw new Error('Invalid scheduled occurrence');
  const { data: automation, error } = await db
    .from('automations')
    .select('id,user_id,is_active,trigger_type,trigger_config,channel')
    .eq('id', automationId)
    .maybeSingle();
  if (error) throw new Error('Could not load scheduled automation');
  if (
    !automation ||
    !automation.is_active ||
    automation.trigger_type !== 'time_based'
  )
    return;
  // Stage 5: a schedule on Instagram runs only while
  // INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED is on; each of its customer sends
  // re-checks the 24-hour window in the engine and a closed window is skipped
  // and logged window_closed. Nothing is sent outside it.
  const instagram = (automation as { channel?: string | null }).channel === 'instagram';
  if (instagram && !instagramScheduledAutomationsEnabled()) return;
  // once_per_contact: an earlier occurrence may have run for this contact since this one was queued.
  const oncePerContactRun = contactId !== undefined
    && (automation.trigger_config as Record<string, unknown> | null)?.once_per_contact === true;
  if (oncePerContactRun && (await contactsAlreadyRun(accountId, automationId, [contactId!])).size)
    return;
  if (instagram) {
    await runInstagramOccurrence(accountId, automationId,
      oncePerContactRun ? `scheduled-once:${automationId}:${contactId}` : `scheduled:${automationId}:${slot}:${contactId ?? 'account'}`,
      slot, contactId, assertLease);
    return;
  }
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
        // Schedules are WhatsApp-only (Instagram's 24-hour window rules out
        // business-initiated runs), and the conversation above is a WhatsApp one.
        channel: 'whatsapp',
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
