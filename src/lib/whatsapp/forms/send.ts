/**
 * Sends a published WhatsApp form as an interactive flow message. Shared by
 * the inbox ("Send form") and the flow engine's send_form node.
 *
 * Order matters for durability: the send is an outbound intent
 * (dispatchOnce), so an ambiguous provider outcome is never blindly
 * re-sent; the session with its one-time flow token is created inside that
 * intent, right before Meta is called; the message row is written after,
 * idempotently on (conversation, wamid), so a replayed intent cannot
 * duplicate it in the inbox.
 */

import type { PrismaClient } from '@prisma/client';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { assertBotRepliesEnabled } from '@/lib/whatsapp/bot-pause';
import { decrypt } from '@/lib/whatsapp/encryption';
import { FLOW_CTA_MAX_LENGTH, sendFlowMessage } from '@/lib/whatsapp/meta-api';
import { isRecipientNotAllowedError, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { getNumberConfig, NoNumberError } from '@/lib/whatsapp/numbers';
import { getT } from '@/lib/i18n/translate';
import { resolveFallbackPolicy } from '@/lib/flows/fallback';
import { normaliseFormDefinition } from './definition';
import { createFormSession, FORM_SESSION_TTL_HOURS } from './sessions';
import type { FormStatus } from './types';

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FORM_BODY_MAX_LENGTH = 1024;

export type FormSendRefusal =
  | 'form_not_found'
  | 'form_not_published'
  | 'conversation_not_found'
  | 'contact_blocked'
  | 'no_address'
  | 'window_closed'
  | 'not_configured'
  | 'form_wrong_number'
  | 'form_key_missing'
  | 'invalid_message';

const REFUSAL_STATUS: Record<FormSendRefusal, number> = {
  form_not_found: 404,
  form_not_published: 409,
  conversation_not_found: 404,
  contact_blocked: 409,
  no_address: 400,
  window_closed: 409,
  not_configured: 400,
  form_wrong_number: 409,
  form_key_missing: 409,
  invalid_message: 400,
};

export class FormSendError extends Error {
  readonly status: number;
  constructor(readonly code: FormSendRefusal) {
    super(getT('Validation.formSend')(code));
    this.name = 'FormSendError';
    this.status = REFUSAL_STATUS[code];
  }
}

export interface FormSendState {
  form: { status: FormStatus | string; meta_flow_id: string | null } | null;
  contact: { phone: string | null; wa_user_id: string | null; blocked_at: Date | string | null } | null;
  lastCustomerMessageAt: Date | string | null;
}

/**
 * Why a form cannot be sent now, or null. Forms are interactive messages,
 * so they need an open 24-hour window (outside it, send a template with a
 * FLOW button). A blocked contact gets no form; an opted-out contact may
 * still get one inside the window, which is a service reply, not marketing.
 */
export function formSendRefusal(state: FormSendState, now = Date.now()): FormSendRefusal | null {
  if (!state.form) return 'form_not_found';
  if (state.form.status !== 'published' || !state.form.meta_flow_id) return 'form_not_published';
  if (!state.contact) return 'conversation_not_found';
  if (state.contact.blocked_at) return 'contact_blocked';
  if (!resolveContactSendTarget(state.contact)) return 'no_address';
  const last = state.lastCustomerMessageAt ? new Date(state.lastCustomerMessageAt).getTime() : NaN;
  if (!Number.isFinite(last) || now - last >= SERVICE_WINDOW_MS) return 'window_closed';
  return null;
}

export interface FormMessageContent {
  cta: string;
  body: string;
  header?: string;
  footer?: string;
}

/** Checks the message around the form before anything is created or sent. */
export function formMessageRefusal(content: FormMessageContent): FormSendRefusal | null {
  const cta = content.cta?.trim() ?? '';
  const body = content.body?.trim() ?? '';
  if (!cta || cta.length > FLOW_CTA_MAX_LENGTH || !body || body.length > FORM_BODY_MAX_LENGTH) return 'invalid_message';
  if ((content.header?.length ?? 0) > 60 || (content.footer?.length ?? 0) > 60) return 'invalid_message';
  return null;
}

/** What the inbox shows for a sent form: its text and the button label. */
export function formMessageText(content: FormMessageContent): string {
  return [content.header, content.body, content.footer].filter((part) => part && part.trim()).join('\n') + `\n[${content.cta}]`;
}

export interface SendFormArgs extends FormMessageContent {
  accountId: string;
  /** Agent sending from the inbox; omitted for the flow engine. */
  userId?: string;
  sender: 'agent' | 'bot';
  /** The caller's membership role; the engine runs as the workspace owner. */
  role: NonNullable<TenantContext['role']>;
  conversationId: string;
  formId: string;
  /** Unique per send attempt; a replay with the same key never sends twice. */
  intentKey: string;
  flowRunId?: string | null;
  nodeKey?: string | null;
  /** Omitted: a flow node's session outlives its wait (formNodeSessionTtlHours), else FORM_SESSION_TTL_HOURS. */
  ttlHours?: number;
}

/** createFormSession's own cap, 30 days. */
const MAX_FORM_SESSION_TTL_HOURS = 720;

/**
 * Hours a send_form node's session must stay valid: at least as long as
 * the node waits for the reply (its timeout, 1 min - 7 days) and as long
 * as the run can stay active (the flow's on_timeout_hours), plus an hour.
 * A submission after the session expires is untrusted and never resumes
 * the run, so a shorter session would drop a reply the run still awaits.
 */
export function formNodeSessionTtlHours(nodeConfig: unknown, fallbackPolicy: unknown): number {
  const minutes = (nodeConfig && typeof nodeConfig === 'object' ? nodeConfig as { timeout_minutes?: unknown } : {}).timeout_minutes;
  const nodeHours = typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 10_080
    ? Math.ceil(minutes / 60) + 1 : 0;
  const runHours = Math.ceil(resolveFallbackPolicy(fallbackPolicy).on_timeout_hours) + 1;
  return Math.min(Math.max(FORM_SESSION_TTL_HOURS, nodeHours, runHours), MAX_FORM_SESSION_TTL_HOURS);
}

export interface SendFormResult {
  whatsappMessageId: string;
  /** Internal messages.id of the persisted row. */
  messageId: string | null;
}

interface Prepared {
  metaFlowId: string;
  formName: string;
  screen: string;
  contactId: string;
  target: { target: string; isPhone: boolean };
  phoneNumberId: string;
  accessTokenEnc: string;
  ttlHours: number;
}

async function sessionTtlHours(tx: TenantTransaction, args: SendFormArgs): Promise<number> {
  if (args.ttlHours !== undefined) return args.ttlHours;
  if (!args.flowRunId || !args.nodeKey) return FORM_SESSION_TTL_HOURS;
  const rows = await tx.$queryRaw<{ config: unknown; fallback_policy: unknown }[]>`
    SELECT n.config,f.fallback_policy FROM flow_runs r
    JOIN flows f ON f.account_id=r.account_id AND f.id=r.flow_id
    LEFT JOIN flow_nodes n ON n.account_id=r.account_id AND n.flow_id=r.flow_id AND n.node_key=${args.nodeKey}
    WHERE r.account_id=${args.accountId}::uuid AND r.id=${args.flowRunId}::uuid`;
  return formNodeSessionTtlHours(rows[0]?.config ?? null, rows[0]?.fallback_policy ?? null);
}

/**
 * Why this number cannot send this form, or null. A Meta Flow exists only in
 * its form's WABA, so a number of another WABA is refused rather than sent
 * from (Meta would reject it). An endpoint form is encrypted with the sending
 * number's own key, so that number must have uploaded one.
 */
export function formNumberRefusal(
  form: { waba_id: string | null; uses_endpoint: boolean },
  number: { waba_id: string | null; forms_private_key_enc: string | null; forms_key_uploaded_at: Date | string | null },
): FormSendRefusal | null {
  if (form.waba_id && number.waba_id !== form.waba_id) return 'form_wrong_number';
  if (form.uses_endpoint && !(number.forms_private_key_enc && number.forms_key_uploaded_at)) return 'form_key_missing';
  return null;
}

async function prepare(tx: TenantTransaction, args: SendFormArgs): Promise<Prepared> {
  const forms = await tx.$queryRaw<{ name: string; status: string; meta_flow_id: string | null; definition: unknown;
    uses_endpoint: boolean; waba_id: string | null }[]>`
    SELECT name,status,meta_flow_id,definition,uses_endpoint,waba_id FROM whatsapp_forms
    WHERE account_id=${args.accountId}::uuid AND id=${args.formId}::uuid`;
  const conversations = await tx.$queryRaw<{ contact_id: string; last_customer_message_at: Date | null; phone: string | null;
    wa_user_id: string | null; blocked_at: Date | null; whatsapp_config_id: string | null }[]>`
    SELECT c.contact_id,
      -- conversations has no such column; the 24-hour window comes from the latest customer message.
      (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
        AND m.sender_type='customer') AS last_customer_message_at,
      ct.phone,ct.wa_user_id,ct.blocked_at,c.whatsapp_config_id::text AS whatsapp_config_id
    FROM conversations c JOIN contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
    WHERE c.account_id=${args.accountId}::uuid AND c.id=${args.conversationId}::uuid`;
  const conversation = conversations[0] ?? null;
  const refusal = formSendRefusal({ form: forms[0] ?? null, contact: conversation,
    lastCustomerMessageAt: conversation?.last_customer_message_at ?? null });
  if (refusal) throw new FormSendError(refusal);
  // The conversation's number; the workspace default for a legacy row.
  const config = await getNumberConfig(tx, args.accountId, conversation?.whatsapp_config_id ?? null).catch((error: unknown) => {
    if (error instanceof NoNumberError) throw new FormSendError('not_configured');
    throw error;
  });
  if (!config.phone_number_id || !config.access_token) throw new FormSendError('not_configured');
  const refusedNumber = formNumberRefusal(forms[0], config);
  if (refusedNumber) throw new FormSendError(refusedNumber);
  const definition = normaliseFormDefinition(forms[0].definition);
  if (!definition.screens[0]) throw new FormSendError('form_not_published');
  return {
    metaFlowId: forms[0].meta_flow_id!,
    formName: forms[0].name,
    screen: definition.screens[0].id,
    contactId: conversation!.contact_id,
    target: resolveContactSendTarget(conversation!)!,
    phoneNumberId: config.phone_number_id,
    accessTokenEnc: config.access_token,
    ttlHours: await sessionTtlHours(tx, args),
  };
}

/**
 * Sends one form. Throws FormSendError for a refusal (nothing created or
 * sent), MetaApiError when Meta rejects it, and UncertainDispatchError when
 * the outcome is unknown and must be reconciled rather than retried.
 */
export async function sendForm(args: SendFormArgs): Promise<SendFormResult> {
  const content = { cta: args.cta.trim(), body: args.body.trim(), header: args.header?.trim() || undefined, footer: args.footer?.trim() || undefined };
  if (formMessageRefusal(content)) throw new FormSendError('invalid_message');
  const prisma: PrismaClient = args.sender === 'bot' ? getWorkerPrisma() : getPrisma();
  const context: TenantContext = { accountId: args.accountId, userId: args.userId, role: args.role };
  const prepared = await withTenant(context, (tx) => prepare(tx, args), prisma);

  const { whatsapp_message_id } = await dispatchOnce(args.accountId, args.intentKey, async () => {
    if (args.sender === 'bot') await assertBotRepliesEnabled(args.accountId, args.conversationId);
    const { flowToken } = await withTenant(context, (tx) => createFormSession(tx, {
      accountId: args.accountId, formId: args.formId, contactId: prepared.contactId, conversationId: args.conversationId,
      flowRunId: args.flowRunId ?? null, nodeKey: args.nodeKey ?? null, ttlHours: prepared.ttlHours,
    }), prisma);
    const accessToken = decrypt(prepared.accessTokenEnc);
    const variants = prepared.target.isPhone ? phoneVariants(prepared.target.target) : [prepared.target.target];
    let lastError: unknown = null;
    for (const to of variants) {
      try {
        return await sendFlowMessage({ phoneNumberId: prepared.phoneNumberId, accessToken, to, flowId: prepared.metaFlowId,
          flowToken, screen: prepared.screen, ...content });
      } catch (error) {
        if (!isRecipientNotAllowedError(error instanceof Error ? error.message : String(error))) throw error;
        lastError = error;
      }
    }
    throw lastError;
  });

  const text = formMessageText(content);
  const messageId = await withTenant(context, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,
        content_text,message_id,status)
      VALUES(${args.accountId}::uuid,${args.conversationId}::uuid,${args.sender},'interactive',${text},${whatsapp_message_id},'sent')
      ON CONFLICT(conversation_id,message_id) DO NOTHING RETURNING id`;
    // An agent stepping in pauses the bot, as every inbox send does.
    await tx.$executeRaw`UPDATE conversations SET last_message_text=${text},last_message_at=NOW(),updated_at=NOW(),
        bot_paused=CASE WHEN ${args.sender}='agent' THEN true ELSE bot_paused END
      WHERE account_id=${args.accountId}::uuid AND id=${args.conversationId}::uuid`;
    return rows[0]?.id ?? null;
  }, prisma);
  return { whatsappMessageId: whatsapp_message_id, messageId };
}

/** A template's FLOW button may be tapped days later, so its session lives longer. */
export const TEMPLATE_FORM_SESSION_TTL_HOURS = 720;

/**
 * One fresh session per FLOW button of a template being sent, keyed by the
 * button index for SendTimeParams.flowTokens. A button whose Meta flow id
 * matches no form of this account gets no token (the submission is then
 * stored without a form). Runs as the workspace owner on the worker
 * connection: the caller has already authorised the send, and RLS still
 * scopes every row to `accountId`.
 */
export async function templateFlowTokens(args: {
  accountId: string;
  buttons: ReadonlyArray<{ type: string; flow_id?: string }> | null | undefined;
  contactId: string | null;
  conversationId: string | null;
  flowRunId?: string | null;
  /**
   * Makes the sessions once per key: the first call records the tokens on
   * an outbound intent in the same transaction, and every later call (a
   * resumed or retried campaign pass, another phone variant) gets those
   * same tokens back instead of new sessions.
   */
  intentKey?: string;
}): Promise<Record<number, string> | undefined> {
  const flows = (args.buttons ?? []).map((b, index) => ({ index, flowId: b.type === 'FLOW' ? b.flow_id : undefined }))
    .filter((b): b is { index: number; flowId: string } => typeof b.flowId === 'string' && b.flowId.length > 0);
  if (!flows.length) return undefined;
  return withTenant({ accountId: args.accountId, role: 'owner' }, async (tx) => {
    if (!args.intentKey) return createTemplateSessions(tx, args, flows);
    // Same key scheme as dispatchOnce, so the intent is scoped to this account.
    const idempotencyKey = `${args.accountId}:${args.intentKey}`;
    const claim = await tx.$queryRaw<{ id: string }[]>`INSERT INTO outbound_intents(account_id,idempotency_key,status,result)
      VALUES(${args.accountId}::uuid,${idempotencyKey},'accepted','{}'::jsonb)
      ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`;
    if (!claim.length) {
      const existing = await tx.$queryRaw<{ result: unknown }[]>`SELECT result FROM outbound_intents
        WHERE account_id=${args.accountId}::uuid AND idempotency_key=${idempotencyKey}`;
      return storedFlowTokens(existing[0]?.result);
    }
    const tokens = await createTemplateSessions(tx, args, flows);
    await tx.$executeRaw`UPDATE outbound_intents SET result=${JSON.stringify(tokens ?? {})}::jsonb,updated_at=NOW()
      WHERE id=${claim[0].id}::uuid`;
    return tokens;
  }, getWorkerPrisma());
}

/** Tokens recorded by an earlier templateFlowTokens call with the same intent key. */
function storedFlowTokens(result: unknown): Record<number, string> | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const tokens: Record<number, string> = {};
  for (const [key, value] of Object.entries(result)) {
    if (/^\d+$/.test(key) && typeof value === 'string' && value) tokens[Number(key)] = value;
  }
  return Object.keys(tokens).length ? tokens : undefined;
}

async function createTemplateSessions(tx: TenantTransaction,
  args: { accountId: string; contactId: string | null; conversationId: string | null; flowRunId?: string | null },
  flows: { index: number; flowId: string }[]): Promise<Record<number, string> | undefined> {
  const tokens: Record<number, string> = {};
  for (const { index, flowId } of flows) {
    const forms = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM whatsapp_forms
      WHERE account_id=${args.accountId}::uuid AND meta_flow_id=${flowId} ORDER BY updated_at DESC LIMIT 1`;
    if (!forms[0]) continue;
    const { flowToken } = await createFormSession(tx, { accountId: args.accountId, formId: forms[0].id,
      contactId: args.contactId, conversationId: args.conversationId, flowRunId: args.flowRunId ?? null,
      ttlHours: TEMPLATE_FORM_SESSION_TTL_HOURS });
    tokens[index] = flowToken;
  }
  return Object.keys(tokens).length ? tokens : undefined;
}
