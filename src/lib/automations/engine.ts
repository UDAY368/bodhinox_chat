import { isWithinTimeWindow } from './time-of-day'
import { dispatchOnce } from '@/lib/jobs/dispatch'
import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  AdClickAutomationTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
  Channel,
} from '@/types'
import { databaseAdmin } from './admin-client'
import { canOwnConversations, nextRoundRobinAgent } from './round-robin'
import { marketingSuppression } from '@/lib/contacts/consent'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { writeContactField } from '@/lib/contacts/field-write'
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain'
import { engineSendText, engineSendTemplate, engineSendInteractive,
} from './meta-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { fillWorkspace, workspaceValuesFor } from '@/lib/workspace/attributes'
import { getT } from '@/lib/i18n/translate'
import { ContactConversationLookupError, pickContactConversationId } from '@/lib/whatsapp/contact-conversation'
import type { FlowSend } from '@/lib/flows/channel-send'
import { safeFetch } from '@/lib/webhooks/safe-fetch'
import { jsonEscape } from '@/lib/flows/api-request'
import { notifyAutomationNotice } from '@/lib/notifications/emit'
import { NOTIFY_TEXT_MAX, automationChannel, webhookHeaderProblem } from './validate'

/** notify_team step config (Phase 12). */
interface NotifyTeamStepConfig {
  audience?: 'assignee' | 'admins'
  text?: string
}

/** What a send_webhook dispatch records: an HTTP status, or a definite local refusal. Never the body. */
type WebhookOutcome = { status: number } | { refused: 'blocked' | 'invalid_url' | 'too_large' }

/** A network error or timeout: the receiver may or may not have the POST. */
class WebhookOutcomeUnknown extends Error {}

/** Step errors land in automation_logs and are shown on the logs page. */
const tErr = getT('LibErrors.engine')

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
  /** Meta ad id of a click-to-WhatsApp referral, for ad_click (never the click id). */
  ad_id?: string
  /** Service of the appointment, for appointment_* triggers. */
  service_id?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  /**
   * The channel the event happened on (Stage 1): only automations of this
   * channel run, and a conversation_id in the context must be on it. Callers
   * take it from the conversation row, WhatsApp when there is none.
   */
  channel: Channel
  triggerType: AutomationTriggerType
  automationId?: string
  contactId?: string | null
  context?: AutomationContext
}

/** The conversation's channel from its row; a pre-Phase 11 row (null) is WhatsApp. */
const rowChannel = (row: { channel?: string | null } | null | undefined): Channel =>
  row?.channel === 'instagram' ? 'instagram' : 'whatsapp'

/** Explicit persisted CTA: run this active definition, independent of its entry trigger. */
export async function runAutomationById(input: {
  accountId: string
  automationId: string
  contactId: string
  context: AutomationContext & { conversation_id: string }
}): Promise<{ outcome: 'started' | 'unavailable' }> {
  const db = databaseAdmin()
  const contact = await db.from('contacts').select('id').eq('account_id', input.accountId).eq('id', input.contactId).maybeSingle()
  if (contact.error) throw new Error('Explicit automation contact lookup failed')
  const conversation = await db.from('conversations').select('id,channel').eq('account_id', input.accountId)
    .eq('id', input.context.conversation_id).eq('contact_id', input.contactId).maybeSingle()
  if (conversation.error) throw new Error('Explicit automation conversation lookup failed')
  if (!contact.data || !conversation.data) return { outcome: 'unavailable' }
  const target = await db.from('automations').select('*').eq('account_id', input.accountId)
    .eq('id', input.automationId).eq('is_active', true).maybeSingle()
  if (target.error) throw new Error('Explicit automation target lookup failed')
  const automation = target.data as Automation | null
  if (!automation || automation.account_id !== input.accountId || !automation.is_active) return { outcome: 'unavailable' }
  // An automation runs only on its own channel's conversations.
  const channel = rowChannel(conversation.data as { channel?: string | null })
  if (automationChannel(automation) !== channel) return { outcome: 'unavailable' }
  const started = await executeAutomation(automation, { ...input, channel, triggerType: automation.trigger_type,
  })
  return { outcome: started ? 'started' : 'unavailable' }
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<boolean> {
  let matched = false
  try {
    const db = databaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id,blocked_at')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return true
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return true
      }
      // A blocked contact gets no automated messages (lib/contacts/consent).
      if (owned.blocked_at) return true
    }

    // Same argument for `context.conversation_id` (GHSA-m4fx-g6pr-hrw8).
    // It rides in on the same caller-supplied body, and every send step
    // writes a `messages` row and a `conversations` preview update keyed
    // on it through the service-role client — so an unvalidated id let a
    // caller inject a message into another tenant's conversation. Refuse
    // the same way: silently, with no existence oracle.
    if (input.context?.conversation_id) {
      const { data: conv, error: convErr } = await db
        .from('conversations')
        .select('id,channel')
        .eq('id', input.context.conversation_id)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (convErr) {
        console.error('[automations] conversation ownership check failed:', convErr)
        return true
      }
      if (!conv) {
        console.warn(
          '[automations] conversation not in account, refusing dispatch',
          input.context.conversation_id
        )
        return true
      }
      // A conversation on another channel never reaches this channel's
      // automations (a WhatsApp automation never resolves to an Instagram
      // conversation). Ids only in the log.
      if (rowChannel(conv as { channel?: string | null }) !== input.channel) {
        console.warn('[automations] conversation on another channel, refusing dispatch', input.context.conversation_id)
        return false
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('channel', input.channel)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return true
    }
    if (!automations || automations.length === 0) return false
    if (input.automationId) automations.splice(0, automations.length, ...automations.filter((row: { id: string }) => row.id === input.automationId))

    for (const automation of automations as Automation[]) {
      // Backstop for the query filter: the row's own channel decides.
      if (automationChannel(automation) !== input.channel) continue
      if (!triggerMatches(automation, input.context)) continue
      matched = true
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
    return true
  }
  return matched
}

/**
 * Why a parked run must not go on for this contact: a blocked contact gets no
 * automated messages, and STOP ends parked runs as it ends flow runs
 * (lib/contacts/consent). The contacts trigger expires such rows when the flag
 * is set; this re-check covers a row already claimed or set before it.
 */
async function contactStopsResume(db: ReturnType<typeof databaseAdmin>, accountId: string,
  contactId: string | null): Promise<string | null> {
  if (!contactId) return null
  const { data, error } = await db.from('contacts').select('blocked_at,opted_out_at')
    .eq('account_id', accountId).eq('id', contactId).maybeSingle()
  if (error) throw new Error('Contact consent lookup failed')
  const contact = data as { blocked_at?: string | null; opted_out_at?: string | null } | null
  if (contact?.blocked_at) return tErr('contactBlockedWhileWaiting')
  if (contact?.opted_out_at) return tErr('contactOptedOutWhileWaiting')
  return null
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  parked_step_id?: string | null
  context: AutomationContext
}): Promise<void> {
  const db = databaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .eq('account_id', pending.account_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed')
    return
  }

  if (!automation.is_active) {
    await markPending(pending.id, 'expired')
    await setLogError(pending.log_id, tErr('pausedWhileWaiting'))
    return
  }
  // A lookup error throws: the automation.resume job retries the still-running row.
  const stopped = await contactStopsResume(db, pending.account_id, pending.contact_id)
  if (stopped) {
    await markPending(pending.id, 'expired')
    await setLogError(pending.log_id, stopped)
    return
  }

  try {
    const resumePoint = await resolveResumePoint(pending, pending.automation_id)
    if (!resumePoint) {
      await markPending(pending.id, 'expired')
      await setLogError(pending.log_id, tErr('parkedStepRemoved'))
      return
    }
    await runResumed({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      ...resumePoint,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

/** How long a `wait_for_reply` step waits: WhatsApp's 24h service window. */
export const REPLY_WAIT_MS = 24 * 60 * 60 * 1000

export interface AwaitingReplyInput {
  accountId: string
  contactId: string
  /** The inbound's channel: only a run parked by an automation of this channel takes the reply. */
  channel: Channel
  /** Worker routing only: reserve questions at a verified menu for AI. */
  reserveMenuTextForAi?: boolean
  /** The inbound that may be the reply. Overwrites the parked run's
   *  message fields so the steps after the wait see the reply. */
  context: Pick<AutomationContext, 'message_text' | 'conversation_id' | 'interactive_reply_id'>
}

/**
 * Hand an inbound message to the contact's automation run that is parked
 * at a `wait_for_reply` step, if there is one.
 *
 * Returns true when a parked run took the message — the caller then
 * skips the content triggers (`new_message_received`, `keyword_match`,
 * `interactive_reply`) and AI auto-reply for it, the same way a Flow
 * consuming a message suppresses them.
 *
 * Must never throw — it runs inside the webhook's `after()` block.
 */
export async function resumeAwaitingReply(input: AwaitingReplyInput): Promise<boolean | 'ai_fallback'> {
  let claimedId: string | null = null
  try {
    const db = databaseAdmin()
    // Newest first; a park supersedes older waits, so normally there is
    // at most one. The deadline is checked here rather than trusted to
    // the cron sweep, so an expired wait is never resumed even when the
    // cron isn't running.
    const { data: rows, error } = await db
      .from('automation_pending_executions')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('contact_id', input.contactId)
      .eq('status', 'awaiting_reply')
      .gt('run_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(PARKED_LOOKUP_LIMIT)
    if (error) {
      console.error('[automations] awaiting-reply lookup failed:', error)
      return false
    }
    // The newest run parked on this channel: a contact may wait on a WhatsApp
    // menu and an Instagram menu at once, and each reply belongs to its own.
    const pending = (await parkedOnChannel(db, input.accountId, (rows ?? []) as PendingRow[], input.channel))[0]
    if (!pending) return false

    if (input.reserveMenuTextForAi && !input.context.interactive_reply_id && input.context.message_text?.trim()) {
      // parkForReply stores exactly position+1 within the current scope.
      // Only a unique, still-active interactive predecessor proves that
      // this continuation belongs to a menu; generic waits keep their rules.
      const predecessorQuery = db.from('automation_steps').select('*')
        .eq('automation_id', pending.automation_id)
      const legacyPosition =
        pending.parent_step_id === null
          ? predecessorQuery
              .eq('position', pending.next_step_position - 1)
              .is('parent_step_id', null)
        : predecessorQuery
              .eq('position', pending.next_step_position - 1)
              .eq('parent_step_id', pending.parent_step_id).eq('branch', pending.branch ?? 'yes')
      const scoped = pending.parked_step_id
        ? db
            .from('automation_steps')
            .select('*')
            .eq('automation_id', pending.automation_id)
            .eq('id', pending.parked_step_id)
        : legacyPosition
      const { data: predecessors, error: predecessorError } = await scoped
      if (predecessorError) return true // uncertainty must not introduce another responder
      if (predecessors?.length === 1 && waitsForReply(predecessors[0] as AutomationStep)) {
        const { data: active, error: activeError } = await db.from('automations').select('id,is_active')
          .eq('id', pending.automation_id).eq('account_id', input.accountId).maybeSingle()
        if (activeError) return true
        if (active?.is_active) return 'ai_fallback'
      }
    }

    // Claim it. Gated on the CURRENT status so two deliveries racing on
    // the same parked run can't both resume it.
    const { data: claim } = await db
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', pending.id)
      .eq('status', 'awaiting_reply')
      .select('id')
      .maybeSingle()
    if (!claim) return false
    claimedId = pending.id

    const { data: automation } = await db
      .from('automations')
      .select('*')
      .eq('id', pending.automation_id)
      .eq('account_id', input.accountId)
      .maybeSingle()
    if (!automation || !(automation as Automation).is_active) {
      // Paused or deleted while waiting: drop the wait and let the
      // message go through the normal triggers instead.
      await markPending(pending.id, 'expired')
      await setLogError(pending.log_id, tErr('pausedWhileWaitingForReply'))
      return false
    }
    const stopped = await contactStopsResume(db, input.accountId, pending.contact_id)
    if (stopped) {
      await markPending(pending.id, 'expired')
      await setLogError(pending.log_id, stopped)
      return false
    }

    const resumePoint = await resolveResumePoint(pending, pending.automation_id)
    if (!resumePoint) {
      await markPending(pending.id, 'expired')
      await setLogError(pending.log_id, tErr('parkedStepRemoved'))
      return false
    }
    await runResumed({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: {
        ...(pending.context ?? {}),
        // Always overwrite all three, so a typed reply can't inherit a
        // stale tap id from the message that started the run.
        message_text: input.context.message_text ?? '',
        conversation_id: input.context.conversation_id,
        interactive_reply_id: input.context.interactive_reply_id,
      },
      ...resumePoint,
      logId: pending.log_id,
      triggerEvent: 'resumed_reply',
    })
    await markPending(pending.id, 'done')
    return true
  } catch (err) {
    console.error('[automations] awaiting-reply resume failed:', err)
    if (claimedId) {
      // The message was already taken by the claim; report it consumed so
      // it doesn't ALSO fan out to other automations.
      await markPending(claimedId, 'failed').catch(() => {})
      return true
    }
    return false
  }
}

/** How many of a contact's parked runs a reply looks through (normally there is one per channel). */
const PARKED_LOOKUP_LIMIT = 10

/**
 * Of these parked rows (kept in order), those whose automation runs on
 * `channel`. A row whose automation is gone counts, so the resume path
 * expires it as before.
 */
async function parkedOnChannel<R extends { automation_id: string }>(
  db: ReturnType<typeof databaseAdmin>,
  accountId: string,
  rows: R[],
  channel: Channel
): Promise<R[]> {
  if (!rows.length) return rows
  const ids = [...new Set(rows.map((row) => row.automation_id))]
  const { data, error } = await db.from('automations').select('id,channel')
    .eq('account_id', accountId).in('id', ids)
  if (error) throw new Error('Parked run channel lookup failed')
  const channels = new Map(((data ?? []) as { id: string; channel?: string | null }[])
    .map((row) => [row.id, automationChannel(row)] as const))
  return rows.filter((row) => (channels.get(row.automation_id) ?? channel) === channel)
}

/**
 * Close out `wait_for_reply` runs whose 24h deadline passed with no
 * reply. Called from the automations cron. Nothing is sent to the
 * customer; the log stays `partial` with an explanatory error_message.
 * Returns how many runs expired.
 */
export async function expireAwaitingReplies(now: Date = new Date()): Promise<number> {
  const db = databaseAdmin()
  const { data, error } = await db
    .from('automation_pending_executions')
    .update({ status: 'expired' })
    .eq('status', 'awaiting_reply')
    .lte('run_at', now.toISOString())
    .select('id, log_id')
  if (error) {
    console.error('[automations] expire awaiting replies failed:', error)
    return 0
  }
  const rows = (data ?? []) as { id: string; log_id: string | null }[]
  for (const row of rows) {
    await setLogError(row.log_id, tErr('noReplyWithin24h'))
  }
  return rows.length
}

interface PendingRow {
  id: string
  automation_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  parked_step_id?: string | null
  context: AutomationContext | null
}

type ResumePoint = Pick<
  ExecuteArgs,
  'parentStepId' | 'branch' | 'startPosition'
>

async function resolveResumePoint(
  pending: Pick<
    PendingRow,
    'parent_step_id' | 'branch' | 'next_step_position' | 'parked_step_id'
  >,
  automationId: string
): Promise<ResumePoint | null> {
  if (pending.parked_step_id) {
    const { data: parkedStep, error } = await databaseAdmin()
      .from('automation_steps')
      .select('id, parent_step_id, branch, position')
      .eq('id', pending.parked_step_id)
      .eq('automation_id', automationId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!parkedStep) return null
    const step = parkedStep as Pick<
      AutomationStep,
      'parent_step_id' | 'branch' | 'position'
    >
    return {
      parentStepId: step.parent_step_id ?? null,
      branch: step.parent_step_id ? (step.branch ?? 'yes') : null,
      startPosition: step.position + 1,
    }
  }
  if (pending.branch !== null && pending.parent_step_id === null) return null
  return {
    parentStepId: pending.parent_step_id,
    branch: pending.branch,
    startPosition: pending.next_step_position,
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const db = databaseAdmin()

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      // Seeded pessimistically. The row is written BEFORE any step runs,
      // and every terminal path below overwrites it (`appendResults` at
      // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
      // run that died mid-flight — the process frozen, the pod recycled —
      // left a permanent `status: 'success'` with `steps_executed: []`,
      // indistinguishable from an automation that genuinely had nothing
      // to do. 'failed' inverts that: the status only becomes success if
      // execution actually reached the end. See issue #409.
      status: 'failed',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return false
  }

  const outcome = await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
  return outcome !== 'failed'
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

/**
 * How a scope ended. `suspended` means a `wait` / `wait_for_reply` step
 * parked the run: every enclosing scope must stop too, or the steps
 * after a condition would run before the branch's own remaining steps.
 */
type ScopeOutcome = 'completed' | 'suspended' | 'failed'

async function executeStepsFrom(args: ExecuteArgs): Promise<ScopeOutcome> {
  const db = databaseAdmin()

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped

  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message)
    return 'failed'
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return 'completed'
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      const { error: waitErr } = await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
          parked_step_id: step.id,
          context: args.context,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      })
      if (waitErr) {
        errorMessage = tErr('scheduleWaitFailed', { message: waitErr.message })
        results.push({
          step_id: step.id,
          step_type: step.step_type,
          status: 'failed',
          detail: errorMessage,
        })
        status = 'failed'
        break
      }
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      return suspend(args, results, errorMessage)
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        const branchOutcome = await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        // The branch parked: stop here too. The steps after this
        // condition run when the branch resumes and climbs back out
        // (see runResumed).
        if (branchOutcome === 'suspended') {
          return suspend(args, results, errorMessage)
        }
        if (branchOutcome === 'failed') {
          status = 'failed'
          break
        }
        continue
      }

      const detail = await runStep(step, args)
      if (waitsForReply(step)) {
        await parkForReply(step, args)
        results.push({
          step_id: step.id,
          step_type: step.step_type,
          status: 'success',
          detail: `${detail}; waiting for reply`,
        })
        return suspend(args, results, errorMessage)
      }
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
  return status === 'failed' ? 'failed' : 'completed'
}

/** Record a parked scope's results and report the suspension upward. */
async function suspend(
  args: ExecuteArgs,
  results: AutomationLogStepResult[],
  errorMessage: string | null
): Promise<ScopeOutcome> {
  // Only the outermost scope owns the log status (same rule as below).
  await appendResults(
    args.logId,
    results,
    args.parentStepId === null ? 'partial' : null,
    errorMessage
  )
  return 'suspended'
}

/**
 * Continue a parked run, then climb out of every enclosing condition
 * branch. A run can park inside a branch; once that branch's remaining
 * steps finish, execution has to carry on after the condition that owns
 * it, in the condition's own scope, all the way back to the root.
 */
async function runResumed(args: ExecuteArgs): Promise<void> {
  const db = databaseAdmin()
  let outcome = await executeStepsFrom(args)
  let owner = args.parentStepId

  while (outcome === 'completed' && owner !== null) {
    const { data: cond } = await db
      .from('automation_steps')
      .select('id, parent_step_id, branch, position')
      .eq('id', owner)
      .eq('automation_id', args.automation.id)
      .maybeSingle()
    if (!cond) {
      // The condition was deleted while the run was parked — nothing
      // left to climb into. What did run, ran successfully.
      await setLogStatus(args.logId, 'success')
      return
    }
    const c = cond as Pick<AutomationStep, 'parent_step_id' | 'branch' | 'position'>
    owner = c.parent_step_id ?? null
    outcome = await executeStepsFrom({
      ...args,
      parentStepId: owner,
      branch: c.branch ?? null,
      startPosition: c.position + 1,
    })
  }

  // A nested scope never sets the log status itself, so a failure there
  // has to be promoted here or the log stays `partial` forever.
  if (outcome === 'failed' && owner !== null) {
    await setLogStatus(args.logId, 'failed')
  }
}

function waitsForReply(step: AutomationStep): boolean {
  if (step.step_type !== 'send_buttons' && step.step_type !== 'send_list') return false
  return (step.step_config as SendButtonsStepConfig).wait_for_reply === true
}

/**
 * Park the run after an interactive send until the contact replies.
 * The newest menu wins: any other run already waiting on this contact
 * is superseded, so a reply can never resume a stale menu.
 */
async function parkForReply(step: AutomationStep, args: ExecuteArgs): Promise<void> {
  const db = databaseAdmin()
  // Only this channel's waits: a menu on the contact's other channel keeps waiting for its own reply.
  const { data: waiting, error: waitingError } = await db
    .from('automation_pending_executions')
    .select('id,automation_id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .eq('status', 'awaiting_reply')
  const superseded = waitingError ? null
    : await parkedOnChannel(db, args.automation.account_id, (waiting ?? []) as { id: string; automation_id: string }[],
      automationChannel(args.automation)).catch(() => null)
  if (superseded === null) {
    // Lookup failed: supersede every wait of the contact, as before channels.
    await db
      .from('automation_pending_executions')
      .update({ status: 'superseded' })
      .eq('account_id', args.automation.account_id)
      .eq('contact_id', args.contactId)
      .eq('status', 'awaiting_reply')
  } else if (superseded.length) {
    await db
      .from('automation_pending_executions')
      .update({ status: 'superseded' })
      .eq('account_id', args.automation.account_id)
      .in('id', superseded.map((row) => row.id))
      .eq('status', 'awaiting_reply')
  }
  const { error } = await db.from('automation_pending_executions').insert({
    automation_id: args.automation.id,
    account_id: args.automation.account_id,
    user_id: args.automation.user_id,
    contact_id: args.contactId,
    log_id: args.logId,
    parent_step_id: args.parentStepId,
    branch: args.branch,
    next_step_position: step.position + 1,
    parked_step_id: step.id,
    context: args.context,
    // For awaiting_reply rows run_at is the reply deadline (migration 045).
    run_at: new Date(Date.now() + REPLY_WAIT_MS).toISOString(),
    status: 'awaiting_reply',
  })
  if (error) throw new Error(tErr('parkForReplyFailed', { message: error.message }))
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = databaseAdmin()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'send_message' }))
      const text = interpolate(cfg.text, args, await workspaceValuesFor(args.automation.account_id, cfg.text))
      if (!text.trim()) throw new Error(tErr('emptyText'))
      const conversationId = await resolveConversationId(args)
      const sendArgs = {
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId!,
        text,
      }
      const { whatsapp_message_id } = await sendOnChannel(args, step, conversationId,
        { kind: 'text', args: sendArgs }, () => engineSendText(sendArgs))
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: step.step_type }))
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const common = {
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId!,
      }
      const { whatsapp_message_id } = await sendOnChannel(args, step, conversationId,
        interactiveFlowSend(common, payload), () => engineSendInteractive({ ...common, payload }))
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'send_template' }))
      // Templates are WhatsApp messages; an Instagram automation cannot send one.
      if (automationChannel(args.automation) !== 'whatsapp') throw new Error(unavailableOn(automationChannel(args.automation)))
      if (!cfg.template_name) throw new Error(tErr('needsTemplateName'))
      // Templates are business-initiated, so an opted-out contact is skipped.
      const { data: consent, error: consentError } = await db
        .from('contacts')
        .select('opted_out_at,blocked_at')
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      if (consentError) throw new Error('Contact consent lookup failed')
      const suppressed = marketingSuppression(consent)
      if (suppressed) return `template skipped: ${suppressed.toLowerCase()}`
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await dispatchOnce(args.automation.account_id, `automation:${args.logId}:${step.id}`, () => engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId!,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
        bodyValuesOnly: true,
      }))
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error(tErr('needsContactAndTag', { step: 'add_tag' }))
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId!,
        tagId: cfg.tag_id,
      })
      if (!added) return `tag ${cfg.tag_id} already present`

      const depth = getTagChainDepth(args.context)
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId!,
          tagId: cfg.tag_id,
          depth,
        })
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        // The tag was added on this automation's channel (its conversation's).
        channel: automationChannel(args.automation),
        triggerType: 'tag_added',
        contactId: args.contactId!,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      })
      return `tag ${cfg.tag_id} added and tag_added dispatched`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error(tErr('needsContactAndTag', { step: 'remove_tag' }))
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id)
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'assign_conversation' }))
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        agentId = (await nextRoundRobinAgent(args.automation.account_id)) ?? undefined
      }
      if (!agentId) return 'no agent resolved'
      // A pinned member removed or demoted to viewer is skipped; routing assigns instead (audit #51).
      if (cfg.mode !== 'round_robin' && !(await canOwnConversations(args.automation.account_id, agentId))) {
        return `agent ${agentId} can no longer own conversations; left to routing`
      }
      const { error } = await inConversationScope(db
        .from('conversations')
        .update({ assigned_agent_id: agentId }), args)
      if (error) throw new Error(tErr('assignFailed'))
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'update_contact_field' }))
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args, await workspaceValuesFor(args.automation.account_id, cfg.value))

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column. Both writes are scoped to the account.
      if (!(await writeContactField(db, args.automation.account_id, args.contactId, cfg.field, value))) {
        return `field ${cfg.field} not writable from automations`
      }
      return cfg.field.startsWith('custom:') ? 'custom field updated' : `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error(tErr('needsPipelineStage'))
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args, await workspaceValuesFor(args.automation.account_id, cfg.title)),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error(tErr('needsUrl'))
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error(tErr('destinationNotAllowed'))
      }
      // Secret workspace attributes (API keys) resolve only here, never in customer messages.
      const ws = await workspaceValuesFor(args.automation.account_id, JSON.stringify([cfg.body_template, cfg.headers]), { secrets: true })
      // Filled values are JSON-escaped, so a customer's text cannot add keys or break the document.
      const body = cfg.body_template ? interpolate(cfg.body_template, args, ws, jsonEscape) : JSON.stringify(args.context)
      if (cfg.body_template) {
        try { JSON.parse(body) } catch { throw new Error(tErr('webhookInvalidBody')) }
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      for (const [name, value] of Object.entries(cfg.headers ?? {})) {
        const filled = fillWorkspace(String(value), ws)
        if (webhookHeaderProblem(name, filled)) throw new Error(tErr('webhookInvalidHeader'))
        headers[name.toLowerCase()] = filled
      }
      // safeFetch dials only the address it checked (no DNS rebinding), never
      // follows redirects, and caps time and size. The intent makes a retry of
      // this step return the recorded outcome instead of POSTing again; a
      // network error or timeout stays 'unknown' and is never re-sent.
      let outcome: WebhookOutcome
      try {
        outcome = await dispatchOnce<WebhookOutcome>(args.automation.account_id, `auto-webhook:${args.logId}:${step.id}`, async () => {
          // The reply body is not used: judge the POST on its status only.
          const res = await safeFetch(cfg.url, { method: 'POST', headers, body }, { discardBody: true })
          if (res.ok) return { status: res.status }
          if (res.error === 'timeout' || res.error === 'network') throw new WebhookOutcomeUnknown()
          return { refused: res.error }
        })
      } catch (err) {
        if (err instanceof WebhookOutcomeUnknown || (err instanceof Error && err.name === 'UncertainDispatchError')) {
          throw new Error(tErr('webhookUncertain'))
        }
        throw err
      }
      if ('refused' in outcome) {
        throw new Error(outcome.refused === 'blocked' ? tErr('destinationNotAllowed') : tErr('webhookRefused'))
      }
      if (outcome.status < 200 || outcome.status >= 300) throw new Error(tErr('webhookStatus', { status: String(outcome.status) }))
      return `webhook ${outcome.status}`
    }

    case 'notify_team': {
      const cfg = step.step_config as unknown as NotifyTeamStepConfig
      const audience = cfg.audience === 'admins' ? 'admins' : cfg.audience === 'assignee' ? 'assignee' : null
      if (!audience || typeof cfg.text !== 'string' || !cfg.text.trim()) throw new Error(tErr('notifyInvalid'))
      let contactName = ''
      if (args.contactId) {
        const { data } = await db
          .from('contacts')
          .select('name')
          .eq('id', args.contactId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        contactName = String((data as { name?: string | null } | null)?.name ?? '')
      }
      // Only these two names are ever filled in: a notice never carries message content.
      const title = cfg.text.slice(0, NOTIFY_TEXT_MAX).replace(/\{\{\s*(contact\.name|automation\.name)\s*\}\}/g, (_, key: string) =>
        key === 'contact.name' ? contactName : String(args.automation.name ?? '')
      ).replace(/\{\{[^}]*\}\}/g, '')
      // The notice links the triggering conversation (any channel, verified in this
      // account), else the contact's default one; the assignee audience needs it.
      let conversationId: string | null = null
      if (args.context.conversation_id) {
        const { data } = await db
          .from('conversations')
          .select('id')
          .eq('id', args.context.conversation_id)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        conversationId = (data as { id?: string } | null)?.id ?? null
      } else if (args.contactId) {
        conversationId = (await pickContactConversationId(db, args.automation.account_id, args.contactId).catch(() => undefined)) ?? null
      }
      if (audience === 'assignee' && !conversationId) return 'no conversation to notify about'
      const notified = await notifyAutomationNotice({
        accountId: args.automation.account_id,
        automationId: args.automation.id,
        audience,
        title: title.trim() || String(args.automation.name ?? ''),
        conversationId,
        contactId: args.contactId,
        dedupeKey: `automation-notice:${args.logId}:${step.id}`,
      })
      return `team notified (${notified.length})`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'close_conversation' }))
      await inConversationScope(db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() }), args)
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * The conversations an assign/close step changes: the triggering one when the
 * run has it (a contact has one conversation per number), else all of the
 * contact's, as before multi-number.
 */
function inConversationScope<Q extends { eq(field: string, value: unknown): Q }>(query: Q, args: ExecuteArgs): Q {
  const scoped = query.eq('account_id', args.automation.account_id).eq('contact_id', args.contactId)
  const fromCtx = args.context.conversation_id
  return typeof fromCtx === 'string' && fromCtx ? scoped.eq('id', fromCtx) : scoped
}

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) {
    // Re-verify rather than trust the context. Dispatch already checks
    // a caller-supplied id, but a resumed run replays a context that
    // was persisted rows ago, and this is the last point before a
    // service-role write keyed on it (GHSA-m4fx-g6pr-hrw8).
    // The conversation must be on the automation's channel: a WhatsApp
    // automation never sends into an Instagram conversation, or the reverse.
    // It is refused here, before any outbound intent is recorded, so the
    // step fails cleanly instead of leaving an "unknown" intent behind.
    const { data, error } = await databaseAdmin()
      .from('conversations')
      .select('id,channel')
      .eq('id', fromCtx)
      .eq('account_id', args.automation.account_id)
      .maybeSingle()
    if (error) throw new Error(getT('LibErrors.send')('conversationLookupFailed', { message: error.message,
        }))
    if (!data?.id) throw new Error(tErr('conversationNotInAccount'))
    const channel = automationChannel(args.automation)
    if (rowChannel(data as { channel?: string | null }) !== channel) throw new Error(unavailableOn(channel))
    return data.id as string
  }
  if (!args.contactId) throw new Error(tErr('noContactForConversation'))
  if (automationChannel(args.automation) === 'instagram') {
    // The contact's most recently active Instagram conversation.
    const { data, error } = await databaseAdmin()
      .from('conversations')
      .select('id')
      .eq('account_id', args.automation.account_id)
      .eq('contact_id', args.contactId)
      .eq('channel', 'instagram')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
    if (error) throw new Error(getT('LibErrors.send')('conversationLookupFailed', { message: error.message }))
    const id = ((Array.isArray(data) ? data[0] : data) as { id?: string } | null)?.id
    if (!id) throw new Error(tErr(args.triggerEvent === 'tag_added' ? 'tagAddedNoConversation' : 'noConversation'))
    return id
  }
  // One conversation per (contact, number): the default number's thread.
  let conversationId: string | undefined
  try {
    conversationId = await pickContactConversationId(databaseAdmin(), args.automation.account_id, args.contactId)
  } catch (error) {
    const cause = error instanceof ContactConversationLookupError ? error.cause : error
    const message = cause && typeof cause === 'object' && 'message' in cause ? String((cause as { message: unknown }).message) : 'lookup failed'
    throw new Error(getT('LibErrors.send')('conversationLookupFailed', { message }))
  }
  if (!conversationId) {
    throw new Error(
      tErr(args.triggerEvent === 'tag_added' ? 'tagAddedNoConversation' : 'noConversation')
    )
  }
  return conversationId
}

const tChannel = getT('Automations.channelSection')
const tChannelNames = getT('Channels.names')
/** A step or conversation the automation's channel cannot use (the fixed, translated text only). */
function unavailableOn(channel: Channel): string {
  return tChannel('unavailableOnChannel', { channel: tChannelNames(channel) })
}

/**
 * A customer send on the automation's channel under the step's intent key.
 * WhatsApp: exactly as before (dispatchOnce around the WhatsApp sender).
 * Instagram: channel-send, which refuses before any intent exists when the
 * 24-hour window is closed, the account cannot send or the message does not
 * fit, and records the Graph call under the same key. Automated: never the
 * Human Agent tag.
 */
async function sendOnChannel(
  args: ExecuteArgs,
  step: AutomationStep,
  conversationId: string,
  instagram: FlowSend,
  whatsapp: () => Promise<{ whatsapp_message_id: string }>
): Promise<{ whatsapp_message_id: string }> {
  const key = `automation:${args.logId}:${step.id}`
  if (automationChannel(args.automation) === 'instagram') {
    // Loaded only for Instagram, so the WhatsApp path's module graph is unchanged.
    const { flowSend } = await import('@/lib/flows/channel-send')
    return flowSend({ account_id: args.automation.account_id, conversation_id: conversationId }, key, instagram)
  }
  return dispatchOnce(args.automation.account_id, key, whatsapp)
}

/** An interactive step as a channel send (sent on Instagram as quick replies). */
function interactiveFlowSend(
  common: { accountId: string; userId: string; conversationId: string; contactId: string },
  payload: SendButtonsStepConfig | SendListStepConfig
): FlowSend {
  if (payload.kind === 'buttons') {
    return { kind: 'buttons', args: { ...common, bodyText: payload.body, headerText: payload.header,
      footerText: payload.footer, buttons: payload.buttons } }
  }
  return { kind: 'list', args: { ...common, bodyText: payload.body, buttonLabel: payload.button_label,
    headerText: payload.header, footerText: payload.footer, sections: payload.sections } }
}

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/**
 * Whole-word keyword test, behind `match_type: 'word'` (issue #409 — a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Exported for direct unit testing of the escaping / boundary edges.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false
): boolean {
  if (!keyword) return false
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu'
  )
  return pattern.test(text)
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive)
      )
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  // A click-to-WhatsApp ad: the listed ad ids, or any ad when none are listed.
  if (automation.trigger_type === 'ad_click') {
    // '' is an ad click whose ad id Meta did not send (or failed validation): it matches "any ad" only.
    const adId = ctx?.ad_id
    if (typeof adId !== 'string') return false
    const ids = (automation.trigger_config as AdClickAutomationTriggerConfig | null)?.ad_ids
    return !Array.isArray(ids) || ids.length === 0 || (adId !== '' && ids.includes(adId))
  }

  // An appointment lifecycle event: the listed services, or any service when none are listed.
  if (typeof automation.trigger_type === 'string' && automation.trigger_type.startsWith('appointment_')) {
    const serviceId = ctx?.service_id
    if (typeof serviceId !== 'string') return false
    const ids = (automation.trigger_config as { service_ids?: unknown } | null)?.service_ids
    return !Array.isArray(ids) || ids.length === 0 || ids.includes(serviceId)
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    const tagId = ctx?.tag_id
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId)
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = databaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand)
      return (count ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand ||
        typeof cfg.value !== 'string' ||
        !cfg.value.trim()
      ) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      if (typeof cfg.value !== 'string' || !cfg.value.trim()) return false
      return text.toLowerCase().includes(cfg.value.toLowerCase())
    }
    case 'time_of_day':
      return isWithinTimeWindow(cfg.operand, new Date(), cfg.timezone)
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(
  s: string,
  args: ExecuteArgs,
  workspace: Record<string, string> = {},
  escape: (value: string) => string = (value) => value
): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return escape(String(args.context.message_text ?? ''))
    if (ns === 'vars' && prop) return escape(String(args.context.vars?.[prop] ?? ''))
    if (ns === 'workspace' && prop && Object.hasOwn(workspace, prop)) return escape(workspace[prop])
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null
) {
  if (!logId) return
  const db = databaseAdmin()
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single()
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Record<string, unknown> = { steps_executed: merged }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status
  }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null
) {
  if (!logId) return
  await databaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId)
}

/** Status-only update, for when error_message must be left as it is. */
async function setLogStatus(
  logId: string | null,
  status: 'success' | 'partial' | 'failed'
) {
  if (!logId) return
  await databaseAdmin().from('automation_logs').update({ status }).eq('id', logId)
}

/** Explain why a parked run ended without touching its status. */
async function setLogError(logId: string | null, errorMessage: string) {
  if (!logId) return
  await databaseAdmin()
    .from('automation_logs')
    .update({ error_message: errorMessage })
    .eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed' | 'expired') {
  await databaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id)
}
