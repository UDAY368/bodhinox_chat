// Actions step (Stage 5): runs an ordered list of actions and sends nothing.
//
// Durability: the run keeps a cursor (run variable `_act:<node key>`, the
// number of finished actions) that is written after each action, so a retry
// or a replay of the step resumes at the action that failed and never repeats
// a finished one. Each action is also idempotent on its own where it can be
// (a tag that is already there, a field set to the same value). The one
// counting action, adding to a workspace field, commits its UPDATE and the
// cursor in one transaction. The cursor is removed once the list is done, so a
// later visit of the step (after a reply, in a loop) runs the list again.
//
// An action that cannot apply (a deleted tag, a secret workspace field, a flow
// that is not live) is skipped with a reason code; an infrastructure error is
// thrown, so the run stops and can be retried or replayed from the cursor.
// Nothing here logs customer content or values: only action types, indexes
// and reason codes.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import type { DataClient } from '@/lib/data/types';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { ContactTagWriteError, removeContactTag } from '@/lib/contacts/tag-write';
import { writeContactField } from '@/lib/contacts/field-write';
import { setChannelConsent } from '@/lib/contacts/channel-consent';
import { pauseAutomations, resumeAutomations } from '@/lib/inbox/automation-pause';
import { logConversion } from '@/lib/analytics/conversion-log';
import { notifyAutomationNotice } from '@/lib/notifications/emit';
import { writeWorkspaceAttribute } from '@/lib/workspace/attribute-write';
import type { Channel } from '@/lib/channels/capabilities';
import { FLOW_ACTION_TYPES, FLOW_STEP_LIMITS, PAUSE_MINUTES_CHOICES, type FlowAction, type FlowRunRow } from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run variable holding the flows a start_flow action queued; they start when this run ends. */
export const START_AFTER_VAR = '_start_after';

/** Contact fields a set_field action or "save answer to" may write (phone and email are checked for owners). */
export const SAVE_CONTACT_FIELDS = ['name', 'email', 'phone', 'company'] as const;

/** The cursor variable of a list of actions on a step (`suffix` tells the step's lists apart). */
export function cursorVar(nodeKey: string, suffix = ''): string {
  return `_act:${nodeKey}${suffix}`;
}

/** Finished actions stored for this list (0 when none or unreadable). */
export function storedCursor(vars: Readonly<Record<string, unknown>>, key: string, length: number): number {
  const raw = vars[key];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= length ? raw : 0;
}

/** The flows a run queued to start when it ends (well-formed ids only, at most 10). */
export function queuedFlowStarts(vars: Readonly<Record<string, unknown>>): string[] {
  const raw = vars[START_AFTER_VAR];
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && UUID.test(id)))].slice(0, 10) : [];
}

/** The actions of a step that are well formed enough to run, in order. */
export function actionList(raw: unknown): FlowAction[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.filter((a): a is FlowAction => Boolean(a) && typeof a === 'object'
    && (FLOW_ACTION_TYPES as readonly string[]).includes((a as { type?: unknown }).type as string))
    .slice(0, FLOW_STEP_LIMITS.actionsMax);
}

export type ContactWriteResult = 'written' | 'conflict' | 'not_writable';

/**
 * Writes a contact field (name, email, phone, company) or a custom field.
 * A phone or email that another contact of the workspace already has is not
 * written and never merges contacts ('conflict'). Values are never logged.
 */
export async function writeContactValue(db: DataClient, input: {
  accountId: string; contactId: string; target: 'contact_field' | 'custom_field'; key: string; value: string;
}): Promise<ContactWriteResult> {
  if (input.target === 'custom_field') {
    if (!UUID.test(input.key)) return 'not_writable';
    return (await writeContactField(db, input.accountId, input.contactId, `custom:${input.key}`, input.value)) ? 'written' : 'not_writable';
  }
  if (!(SAVE_CONTACT_FIELDS as readonly string[]).includes(input.key)) return 'not_writable';
  if (input.key === 'phone') return fillContactPhone(input.accountId, input.contactId, input.value);
  if (input.key === 'email') {
    const owner = await withTenant({ accountId: input.accountId, role: 'owner' }, async (tx) => {
      const rows = input.key === 'email'
        ? await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM contacts WHERE account_id=${input.accountId}::uuid
            AND id<>${input.contactId}::uuid AND lower(email)=lower(${input.value}) LIMIT 1`)
        : [];
      return rows[0]?.id ?? null;
    }, getWorkerPrisma());
    if (owner) return 'conflict';
  }
  return (await writeContactField(db, input.accountId, input.contactId, input.key, input.value)) ? 'written' : 'not_writable';
}

/** A phone number a flow may store: 8 to 15 digits, an optional leading +, spaces, dots, dashes and brackets ignored. */
export function flowPhoneDigits(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, '');
  return /^\+?[1-9]\d{7,14}$/.test(compact) ? compact.replace(/^\+/, '') : null;
}

/**
 * Fills the phone of a contact that has none (an Instagram contact). A
 * contact's existing number is its WhatsApp identity and is never replaced;
 * a number another contact of the workspace has is a conflict (nothing is
 * written, contacts are never merged). Runs on the worker connection.
 */
async function fillContactPhone(accountId: string, contactId: string, value: string): Promise<ContactWriteResult> {
  const digits = flowPhoneDigits(value);
  if (!digits) return 'not_writable';
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const [owner] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM contacts WHERE account_id=${accountId}::uuid
      AND id<>${contactId}::uuid AND phone_normalized=${digits} LIMIT 1`);
    if (owner) return 'conflict' as const;
    const [current] = await tx.$queryRaw<{ phone_normalized: string | null }[]>(Prisma.sql`SELECT phone_normalized FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid FOR UPDATE`);
    if (!current) return 'not_writable' as const;
    if (current.phone_normalized) return current.phone_normalized === digits ? 'written' as const : 'not_writable' as const;
    // The unique (account, phone) index is the final guard against a concurrent writer.
    const updated = await tx.$executeRaw(Prisma.sql`UPDATE contacts SET phone=${digits}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid AND COALESCE(phone, '')=''
        AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.account_id=${accountId}::uuid AND o.id<>${contactId}::uuid AND o.phone_normalized=${digits})`);
    return updated > 0 ? 'written' as const : 'conflict' as const;
  }, getWorkerPrisma());
}

export interface ActionsContext {
  db: DataClient;
  run: FlowRunRow;
  nodeKey: string;
  channel: Channel;
  /** The flow's name, the fixed text of a team notice. */
  flowName: string;
  /** Fills placeholders in a set_field value (the engine's interpolation, contact placeholders included). */
  interpolate: (text: string) => Promise<string>;
  /** Cursor suffix: '' for the Actions step, ':ok' for a question's actions on success. */
  cursorSuffix?: string;
}

export interface ActionSkip { index: number; type: string; reason: string }

export interface ActionsResult {
  /** Actions that could not apply, with a reason code (never a value). */
  skipped: ActionSkip[];
  /** Kinds of the actions that ran this time (not those a cursor skipped). */
  ran: string[];
  /** A pause_automations action ran: the run should stop sending. */
  paused: boolean;
}

type Outcome = { ok: true } | { ok: false; reason: string };
const ok: Outcome = { ok: true };
const skip = (reason: string): Outcome => ({ ok: false, reason });

const worker = <T,>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

/** Moves the cursor in the caller's transaction, only while the run is still active. */
async function writeCursor(tx: TenantTransaction, run: FlowRunRow, key: string, done: number | null): Promise<void> {
  await tx.$executeRaw(done === null
    ? Prisma.sql`UPDATE flow_runs SET vars = vars - ${key} WHERE account_id=${run.account_id}::uuid AND id=${run.id}::uuid AND status='active'`
    : Prisma.sql`UPDATE flow_runs SET vars = vars || jsonb_build_object(${key}::text, ${done}::int)
        WHERE account_id=${run.account_id}::uuid AND id=${run.id}::uuid AND status='active'`);
}

function setLocalCursor(run: FlowRunRow, key: string, done: number | null): void {
  const vars = { ...run.vars };
  if (done === null) delete vars[key];
  else vars[key] = done;
  run.vars = vars;
}

/**
 * Runs the list from the stored cursor. Returns what was skipped; throws on an
 * infrastructure error (the cursor keeps the finished actions).
 */
export async function runActions(ctx: ActionsContext, actions: readonly FlowAction[]): Promise<ActionsResult> {
  const { run } = ctx;
  const key = cursorVar(ctx.nodeKey, ctx.cursorSuffix);
  const start = storedCursor(run.vars, key, actions.length);
  const result: ActionsResult = { skipped: [], ran: [], paused: false };
  for (let index = start; index < actions.length; index += 1) {
    const action = actions[index];
    let outcome: Outcome;
    if (action.type === 'set_workspace_field') {
      // The UPDATE and the cursor commit together, so an addition is never counted twice.
      outcome = await worker(run.account_id, async (tx) => {
        const written = await writeWorkspaceAttribute(tx, run.account_id, { key: action.key, mode: action.mode, value: action.value });
        await writeCursor(tx, run, key, index + 1);
        return written === 'written' ? ok : skip(`workspace_field_${written}`);
      });
    } else {
      outcome = await runOne(ctx, action, index);
      await worker(run.account_id, (tx) => writeCursor(tx, run, key, index + 1));
    }
    setLocalCursor(run, key, index + 1);
    result.ran.push(action.type);
    if (!outcome.ok) result.skipped.push({ index, type: action.type, reason: outcome.reason });
    else if (action.type === 'pause_automations') result.paused = true;
  }
  await worker(run.account_id, (tx) => writeCursor(tx, run, key, null));
  setLocalCursor(run, key, null);
  return result;
}

async function runOne(ctx: ActionsContext, action: FlowAction, index: number): Promise<Outcome> {
  const { run, db } = ctx;
  const accountId = run.account_id;
  const contactId = run.contact_id;
  switch (action.type) {
    case 'add_tag':
    case 'remove_tag': {
      if (!contactId || !UUID.test(action.tag_id ?? '')) return skip('tag_invalid');
      try {
        if (action.type === 'add_tag') {
          await addContactTagAndDispatch({ db, accountId, contactId, tagId: action.tag_id,
            context: { conversation_id: run.conversation_id ?? undefined, vars: run.vars } });
        } else {
          await removeContactTag(db, { accountId, contactId, tagId: action.tag_id });
        }
        return ok;
      } catch (err) {
        // A tag or contact that is not this workspace's (or was deleted) is skipped; anything else retries.
        if (err instanceof ContactTagWriteError && err.status === 404) return skip('tag_unavailable');
        throw err;
      }
    }
    case 'set_field': {
      if (!contactId || (action.target !== 'contact_field' && action.target !== 'custom_field') || typeof action.value !== 'string') return skip('field_invalid');
      const value = (await ctx.interpolate(action.value)).slice(0, 1000);
      const written = await writeContactValue(db, { accountId, contactId, target: action.target, key: action.key, value });
      return written === 'written' ? ok : skip(written === 'conflict' ? 'save_conflict' : 'field_not_writable');
    }
    case 'set_channel_consent': {
      if (!contactId || action.channel !== 'instagram' || (action.state !== 'opted_in' && action.state !== 'opted_out')) return skip('consent_invalid');
      await worker(accountId, (tx) => setChannelConsent(tx, accountId, contactId, 'instagram', action.state));
      return ok;
    }
    case 'subscribe_sequence':
    case 'unsubscribe_sequence':
      if (!contactId || !UUID.test(action.sequence_id ?? '')) return skip('sequence_invalid');
      return action.type === 'subscribe_sequence'
        ? subscribeSequence(accountId, contactId, action.sequence_id, ctx.channel)
        : unsubscribeSequence(accountId, contactId, action.sequence_id);
    case 'start_flow': {
      if (!UUID.test(action.flow_id ?? '') || action.flow_id === run.flow_id) return skip('flow_invalid');
      // One run per conversation: the flow starts when this run ends (engine.ts endRun).
      const queued = [...new Set([...queuedFlowStarts(run.vars), action.flow_id])].slice(0, 10);
      await worker(accountId, (tx) => tx.$executeRaw(Prisma.sql`UPDATE flow_runs
        SET vars = vars || jsonb_build_object(${START_AFTER_VAR}::text, ${JSON.stringify(queued)}::jsonb)
        WHERE account_id=${accountId}::uuid AND id=${run.id}::uuid AND status='active'`));
      run.vars = { ...run.vars, [START_AFTER_VAR]: queued };
      return ok;
    }
    case 'stop_flow': {
      if (!contactId || !UUID.test(action.flow_id ?? '') || action.flow_id === run.flow_id) return skip('flow_invalid');
      await worker(accountId, (tx) => tx.$executeRaw(Prisma.sql`UPDATE flow_runs
        SET status='cancelled', ended_at=now(), end_reason='stopped_by_flow', wait_until=NULL
        WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND flow_id=${action.flow_id}::uuid
          AND status='active' AND id<>${run.id}::uuid`));
      return ok;
    }
    case 'pause_automations': {
      if (!run.conversation_id) return skip('no_conversation');
      const minutes = action.minutes;
      if (!(PAUSE_MINUTES_CHOICES as readonly (number | null)[]).includes(minutes)) return skip('pause_invalid');
      await pauseAutomations(accountId, { conversationId: run.conversation_id, minutes, byUserId: null });
      return ok;
    }
    case 'resume_automations':
      if (!run.conversation_id) return skip('no_conversation');
      await resumeAutomations(accountId, { conversationId: run.conversation_id, byUserId: null });
      return ok;
    case 'log_conversion':
      if (!UUID.test(action.event_type_id ?? '')) return skip('conversion_invalid');
      await logConversion(accountId, { eventTypeId: action.event_type_id, contactId, flowId: run.flow_id, runId: run.id,
        nodeKey: ctx.nodeKey, channel: ctx.channel });
      return ok;
    case 'set_conversation_status': {
      if (!run.conversation_id) return skip('no_conversation');
      if (action.status !== 'open' && action.status !== 'closed') return skip('status_invalid');
      await worker(accountId, (tx) => tx.$executeRaw(Prisma.sql`UPDATE conversations SET status=${action.status}, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${run.conversation_id}::uuid`));
      return ok;
    }
    case 'notify_team': {
      if (action.target !== 'assignee' && action.target !== 'admins') return skip('notify_invalid');
      // Fixed text (the flow's name) plus the author's note; never the customer's message, never interpolated.
      const note = typeof action.note === 'string' ? action.note.trim().slice(0, FLOW_STEP_LIMITS.notifyNoteChars) : '';
      const title = note ? `${ctx.flowName}: ${note}` : ctx.flowName;
      const notified = await notifyAutomationNotice({
        accountId, automationId: run.flow_id, audience: action.target, title: title || 'Flow',
        conversationId: run.conversation_id, contactId,
        dedupeKey: `flow-notice:${run.id}:${ctx.nodeKey}:${run.transition_seq ?? 0}:${index}`,
      });
      return notified.length ? ok : skip('nobody_to_notify');
    }
    default:
      return skip('action_unknown');
  }
}

/**
 * Subscribes the contact to an active-or-draft sequence of this workspace on
 * the run's channel. Idempotent: an existing subscription is left as it is
 * (5H owns the schedule; the first message is due after its own delay).
 */
async function subscribeSequence(accountId: string, contactId: string, sequenceId: string, channel: Channel): Promise<Outcome> {
  return worker(accountId, async (tx) => {
    const [sequence] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM sequences
      WHERE account_id=${accountId}::uuid AND id=${sequenceId}::uuid AND channel=${channel} AND status IN ('active','draft','paused')`);
    if (!sequence) return skip('sequence_unavailable');
    const [optedOut] = await tx.$queryRaw<{ out: boolean }[]>(Prisma.sql`SELECT (opted_out_at IS NOT NULL
        OR (${channel}='instagram' AND instagram_opted_out_at IS NOT NULL)) AS out
      FROM contacts WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`);
    if (!optedOut || optedOut.out) return skip('contact_unsubscribed');
    // A subscription in progress is left alone; one that ended (completed or unsubscribed) starts over.
    await tx.$executeRaw(Prisma.sql`INSERT INTO sequence_subscriptions(account_id, sequence_id, contact_id, next_position, next_due_at)
      SELECT ${accountId}::uuid, ${sequenceId}::uuid, ${contactId}::uuid, 0,
        now() + COALESCE((SELECT make_interval(mins => m.delay_amount * CASE m.delay_unit WHEN 'minutes' THEN 1 WHEN 'hours' THEN 60 ELSE 1440 END)
          FROM sequence_messages m WHERE m.account_id=${accountId}::uuid AND m.sequence_id=${sequenceId}::uuid AND m.active
          ORDER BY m.position LIMIT 1), interval '0')
      ON CONFLICT (account_id, sequence_id, contact_id) DO UPDATE
        SET status='active', next_position=0, next_due_at=EXCLUDED.next_due_at, claimed_at=NULL, ended_at=NULL, subscribed_at=now()
        WHERE sequence_subscriptions.status IN ('completed','unsubscribed')`);
    return ok;
  });
}

/** Ends the contact's subscription at once (sends stop; nothing is deleted). */
async function unsubscribeSequence(accountId: string, contactId: string, sequenceId: string): Promise<Outcome> {
  await worker(accountId, (tx) => tx.$executeRaw(Prisma.sql`UPDATE sequence_subscriptions
    SET status='unsubscribed', ended_at=now(), next_due_at=NULL, claimed_at=NULL
    WHERE account_id=${accountId}::uuid AND sequence_id=${sequenceId}::uuid AND contact_id=${contactId}::uuid
      AND status IN ('active','sending')`));
  return ok;
}
