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
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchOnce } from './dispatch';
import { enqueueJob } from './queue';
import { pickContactConversationId } from '@/lib/whatsapp/contact-conversation';

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
  await requireAudienceReferences(db, audience);
  const contacts = await resolveAudienceContacts(
    db,
    audience,
    async () => {
      throw new Error('CSV recipients are unsupported for schedules');
    },
    { maxRows: MAX_SCHEDULED_CONTACTS }
  );
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
  const steps = await loadSteps(db, automationId);
  if (!contactId && scheduleNeedsContact(steps))
    throw new Error('Scheduled contact actions require explicit recipients');
  let conversationId: string | undefined;
  if (contactId) {
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('id')
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
      if (!conversationId) {
        const inserted = await db
          .from('conversations')
          .upsert(
            {
              account_id: accountId,
              user_id: automation.user_id,
              contact_id: contactId,
              status: 'open',
            },
            // One conversation per (contact, number); the insert trigger
            // fills whatsapp_config_id with the workspace default.
            { onConflict: 'account_id,contact_id,whatsapp_config_id', ignoreDuplicates: true }
          );
        if (inserted.error)
          throw new Error('Could not create scheduled conversation');
        conversationId = await findContactConversationId(db, accountId, contactId);
        if (!conversationId)
          throw new Error('Could not resolve scheduled conversation');
      }
    }
  }
  assertLease();
  await dispatchOnce(
    accountId,
    `scheduled:${automationId}:${slot}:${contactId ?? 'account'}`,
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
