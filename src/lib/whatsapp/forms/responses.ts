/**
 * Form submissions. Meta delivers a completed form as an inbound
 * interactive `nfm_reply` whose `response_json` carries our flow token and
 * the answers keyed by field id. The reply is stored once per inbound
 * message id; the session (when the token is known) supplies the form,
 * and a trusted, first submission may update the contact and resume a
 * waiting flow run.
 */

import type { TenantTransaction } from '@/lib/db/tenant';
import type { DataClient } from '@/lib/data/types';
import { writeContactField } from '@/lib/contacts/field-write';
import { getT } from '@/lib/i18n/translate';
import { normaliseFormDefinition } from './definition';
import { formInputFields } from './flow-json';
import { completeFormSession, findSessionByToken, isFlowToken } from './sessions';
import type { FormDefinition, FormField } from './types';

export type FormAnswer = string | number | boolean | string[];
export type FormAnswers = Record<string, FormAnswer>;

const MAX_RESPONSE_JSON = 65_536;
const MAX_ANSWERS = 100;
const MAX_VALUE = 4096;
const ANSWER_KEY = /^[a-z][a-z0-9_]{0,39}$/;

function answerValue(value: unknown): FormAnswer | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_VALUE);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string').slice(0, 50).map((v) => v.slice(0, 256));
  }
  return undefined;
}

/**
 * Reads a form reply. Address-form replies (`address_message`) are not
 * forms; anything malformed returns null. The flow token is returned
 * separately and never kept with the answers.
 */
export function parseFormReply(
  reply: { name?: string; response_json?: string } | undefined,
): { flowToken: string | null; answers: FormAnswers } | null {
  if (!reply || reply.name === 'address_message' || typeof reply.response_json !== 'string') return null;
  if (reply.name !== undefined && reply.name !== 'flow') return null;
  if (reply.response_json.length > MAX_RESPONSE_JSON) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(reply.response_json); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const answers: FormAnswers = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(answers).length >= MAX_ANSWERS) break;
    if (key === 'flow_token' || !ANSWER_KEY.test(key)) continue;
    const v = answerValue(value);
    if (v !== undefined) answers[key] = v;
  }
  return { flowToken: isFlowToken(raw.flow_token) ? raw.flow_token : null, answers };
}

/** A field's answer as readable text: option titles for choices, yes/no for opt-ins. */
export function displayAnswer(field: FormField | undefined, value: FormAnswer): string {
  const t = getT('FormMessages');
  const title = (id: string) => field?.options?.find((o) => o.id === id)?.title ?? id;
  if (typeof value === 'boolean') return value ? t('yes') : t('no');
  if (Array.isArray(value)) return value.map(title).join(', ');
  return field?.options ? title(String(value)) : String(value);
}

/** The inbox text for a submission: a heading, then one `Label: answer` line per answered field. */
export function formSummaryText(formName: string | null, definition: FormDefinition | null, answers: FormAnswers): string {
  const t = getT('FormMessages');
  const fields = definition ? formInputFields(definition) : [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  const ordered = [...fields.map((f) => f.id).filter((id) => id in answers), ...Object.keys(answers).filter((id) => !byId.has(id))];
  const lines = ordered
    .map((id) => [byId.get(id)?.label ?? id, displayAnswer(byId.get(id), answers[id])] as const)
    .filter(([, v]) => v !== '')
    .map(([label, v]) => `${label}: ${v}`);
  const heading = formName ? t('submitted', { name: formName }) : t('submittedUnknown');
  return [heading, ...lines].join('\n').slice(0, 4096);
}

export interface RecordFormResponseInput {
  accountId: string;
  contactId: string;
  conversationId: string;
  /** Inbound wamid; one response per message. */
  messageId: string;
  flowToken: string | null;
  answers: FormAnswers;
}

export interface RecordedFormResponse {
  inserted: boolean;
  formId: string | null;
  formName: string | null;
  definition: FormDefinition | null;
  /**
   * The first submission on a live session for this contact: only then may
   * answers update the contact and resume a waiting flow run.
   */
  trusted: boolean;
  flowRunId: string | null;
  nodeKey: string | null;
}

/**
 * Stores a submission idempotently and completes its session. An unknown
 * or expired token still stores the answers (with the form when the
 * session exists), so nothing a customer sent is lost.
 */
export async function recordFormResponse(tx: TenantTransaction, input: RecordFormResponseInput): Promise<RecordedFormResponse> {
  // Locked: a second submission on the same session waits and then sees the first.
  const session = input.flowToken ? await findSessionByToken(tx, input.accountId, input.flowToken, { forUpdate: true }) : null;
  let formName: string | null = null;
  let definition: FormDefinition | null = null;
  if (session) {
    const forms = await tx.$queryRaw<{ name: string; definition: unknown }[]>`SELECT name,definition FROM whatsapp_forms
      WHERE account_id=${input.accountId}::uuid AND id=${session.form_id}::uuid`;
    if (forms[0]) {
      formName = forms[0].name;
      definition = normaliseFormDefinition(forms[0].definition);
    }
  }
  const earlier = session ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM whatsapp_form_responses
    WHERE account_id=${input.accountId}::uuid AND session_id=${session.id}::uuid LIMIT 1` : [];
  const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO whatsapp_form_responses(account_id,form_id,session_id,
      contact_id,conversation_id,message_id,response)
    VALUES(${input.accountId}::uuid,${session?.form_id ?? null}::uuid,${session?.id ?? null}::uuid,${input.contactId}::uuid,
      ${input.conversationId}::uuid,${input.messageId},${JSON.stringify(input.answers)}::jsonb)
    ON CONFLICT(account_id,message_id) DO NOTHING RETURNING id`;
  const live = Boolean(session && session.contact_id === input.contactId && new Date(session.expires_at).getTime() > Date.now());
  const trusted = Boolean(inserted.length && live && !earlier.length);
  if (session && inserted.length) await completeFormSession(tx, input.accountId, session.id);
  return {
    inserted: inserted.length > 0,
    formId: session?.form_id ?? null,
    formName,
    definition,
    trusted,
    flowRunId: trusted ? session!.flow_run_id : null,
    nodeKey: trusted ? session!.node_key : null,
  };
}

/** The value a field writes to a contact: option titles for choices, trimmed and capped. */
function saveValue(field: FormField, value: FormAnswer): string {
  return displayAnswer(field, value).trim().slice(0, 255);
}

/**
 * Applies the form's `save_to` mappings for a trusted submission through
 * the shared contact field writer. Returns how many fields were written;
 * a target that is not writable (a deleted custom field, say) is skipped.
 */
export async function applyFormSaveTo(
  db: DataClient,
  accountId: string,
  contactId: string,
  definition: FormDefinition,
  answers: FormAnswers,
): Promise<number> {
  let written = 0;
  for (const field of formInputFields(definition)) {
    const target = field.save_to;
    const value = answers[field.id];
    if (!target || value === undefined) continue;
    const text = saveValue(field, value);
    if (!text) continue;
    const key = target.kind === 'contact_field' ? target.field : `custom:${target.field_id}`;
    if (await writeContactField(db, accountId, contactId, key, text)) written += 1;
  }
  return written;
}

/** A form's current definition, or null when it no longer exists. */
export async function loadFormDefinition(tx: TenantTransaction, accountId: string, formId: string): Promise<FormDefinition | null> {
  const rows = await tx.$queryRaw<{ definition: unknown }[]>`SELECT definition FROM whatsapp_forms
    WHERE account_id=${accountId}::uuid AND id=${formId}::uuid`;
  return rows[0] ? normaliseFormDefinition(rows[0].definition) : null;
}
