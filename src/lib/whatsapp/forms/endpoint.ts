/**
 * The WhatsApp Forms data endpoint, after decryption: answers Meta's ping,
 * error notifications, INIT, BACK and data_exchange for forms compiled with
 * `compileFlowJson(def, { usesEndpoint: true })`.
 *
 * In endpoint mode each screen sends only its own values, so the answers so
 * far live on the form session (keyed by the flow token). Every screen is
 * checked here against the stored definition; the customer's phone is never
 * trusted to have enforced required fields, formats or option ids. The last
 * screen completes the session and hands every answer back to WhatsApp, which
 * delivers them to our webhook as the submission message.
 *
 * Storage is behind `FormsSessionStore` so this file stays pure; the route
 * supplies a tenant-scoped implementation.
 */

import { getT } from '@/lib/i18n/translate';

import { FORM_LIMITS, validateFormDefinition } from './definition';
import { screenInputFields } from './flow-json';
import type { FormDefinition, FormField, FormScreen } from './types';

const t = getT('Api.formsEndpoint');

/** Meta's reserved screen name for the terminal response. */
export const FORMS_SUCCESS_SCREEN = 'SUCCESS';
/** Bounds a single answer so a crafted request cannot bloat the session row. */
const MAX_TEXT_ANSWER = 4096;

export type FormAnswer = string | boolean | string[];
export type FormAnswers = Record<string, FormAnswer>;

export interface FormsSession {
  id: string;
  /** The form's stored definition, as read from the database. */
  definition: unknown;
  answers: FormAnswers;
  expired: boolean;
  completed: boolean;
}

export interface FormsSessionStore {
  find(flowToken: string): Promise<FormsSession | null>;
  /** Merges one screen's values into the session's answers. */
  saveAnswers(sessionId: string, values: FormAnswers): Promise<void>;
  /** Merges the final values and marks the session complete; null when it already was or has expired. */
  complete(sessionId: string, values: FormAnswers): Promise<FormAnswers | null>;
}

export type FormsExchangeResult =
  | { status: 200; body: Record<string, unknown> }
  /** 427: Meta's code for an invalid or expired flow token. */
  | { status: 400 | 427 | 500 };

export type ScreenAnswersResult =
  | { ok: true; values: FormAnswers }
  | { ok: false; fieldId: string; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]{3,22}$/;
const NUMBER = /^-?\d+(?:[.,]\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Older WhatsApp clients send DatePicker values as epoch milliseconds. */
const EPOCH_MS = /^\d{10,13}$/;

function validDate(value: string): boolean {
  if (EPOCH_MS.test(value)) return true;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

function defaultMax(field: FormField): number {
  return field.type === 'long_text' ? FORM_LIMITS.textAreaMaxChars : FORM_LIMITS.textInputMaxChars;
}

/** Checks one field's submitted value; returns the stored value, undefined when empty, or an error message. */
function checkField(field: FormField, raw: unknown): { value?: FormAnswer; error?: string } {
  const label = field.label;
  const optionIds = new Set((field.options ?? []).map((option) => option.id));
  switch (field.type) {
    case 'opt_in': {
      const accepted = raw === true || raw === 'true';
      if (field.required && !accepted) return { error: t('optInRequired', { label }) };
      return { value: accepted };
    }
    case 'checkboxes': {
      const list = raw === undefined || raw === null || raw === '' ? [] : raw;
      if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || !optionIds.has(id))) return { error: t('invalidOption', { label }) };
      const unique = [...new Set(list as string[])];
      if (unique.length === 0) return field.required ? { error: t('required', { label }) } : {};
      if (field.min !== undefined && unique.length < field.min) return { error: t('tooFewSelected', { label, min: field.min }) };
      if (field.max !== undefined && unique.length > field.max) return { error: t('tooManySelected', { label, max: field.max }) };
      return { value: unique };
    }
    default: {
      if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') return { error: t('invalid', { label }) };
      const value = raw === undefined || raw === null ? '' : String(raw).trim();
      if (!value) return field.required ? { error: t('required', { label }) } : {};
      if (value.length > MAX_TEXT_ANSWER) return { error: t('tooLong', { label, max: defaultMax(field) }) };
      if (field.type === 'dropdown' || field.type === 'radio') {
        return optionIds.has(value) ? { value } : { error: t('invalidOption', { label }) };
      }
      if (field.type === 'date') return validDate(value) ? { value } : { error: t('invalidDate', { label }) };
      const max = field.max ?? defaultMax(field);
      if (value.length > max) return { error: t('tooLong', { label, max }) };
      if (field.min !== undefined && field.type !== 'long_text' && value.length < field.min) return { error: t('tooShort', { label, min: field.min }) };
      if (field.type === 'email' && !EMAIL.test(value)) return { error: t('invalidEmail', { label }) };
      if (field.type === 'phone' && (!PHONE.test(value) || value.replace(/\D/g, '').length < 5 || value.replace(/\D/g, '').length > 15)) {
        return { error: t('invalidPhone', { label }) };
      }
      if (field.type === 'number' && !NUMBER.test(value)) return { error: t('invalidNumber', { label }) };
      return { value };
    }
  }
}

/**
 * Validates the values submitted for one screen against its definition.
 * Unknown keys are dropped; empty optional answers are left out.
 */
export function validateScreenAnswers(screen: FormScreen, data: unknown): ScreenAnswersResult {
  const submitted = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const values: FormAnswers = {};
  for (const field of screenInputFields(screen)) {
    const checked = checkField(field, submitted[field.id]);
    if (checked.error) return { ok: false, fieldId: field.id, message: checked.error };
    if (checked.value !== undefined) values[field.id] = checked.value;
  }
  return { ok: true, values };
}

const screenResponse = (screen: FormScreen, data: Record<string, unknown> = {}) =>
  ({ status: 200 as const, body: { screen: screen.id, data } });

/** Handles one decrypted endpoint request. Never logs the request: it carries customer answers. */
export async function handleFormsExchange(request: Record<string, unknown>, store: FormsSessionStore): Promise<FormsExchangeResult> {
  const action = request.action;
  if (action === 'ping') return { status: 200, body: { data: { status: 'active' } } };
  const data = request.data && typeof request.data === 'object' && !Array.isArray(request.data) ? (request.data as Record<string, unknown>) : {};
  // Meta reports a client-side error about our previous response; acknowledging is all it expects.
  if (typeof data.error === 'string') return { status: 200, body: { data: { acknowledged: true } } };
  if (action !== 'INIT' && action !== 'BACK' && action !== 'data_exchange') return { status: 400 };

  const flowToken = request.flow_token;
  if (typeof flowToken !== 'string' || !/^[A-Za-z0-9_-]{43,200}$/.test(flowToken)) return { status: 427 };
  const session = await store.find(flowToken);
  if (!session || session.expired) return { status: 427 };
  const parsed = validateFormDefinition(session.definition);
  if (!parsed.ok) return { status: 500 };
  const definition: FormDefinition = parsed.definition;
  const screens = definition.screens;
  const index = screens.findIndex((screen) => screen.id === request.screen);
  const lastScreen = index === screens.length - 1;

  // A completed session only accepts a repeat of the final submission (its
  // SUCCESS response may have been lost); it never reopens the form.
  if (session.completed && !(action === 'data_exchange' && lastScreen)) return { status: 427 };

  if (action === 'INIT') return screenResponse(screens[0]);
  if (action === 'BACK') return screenResponse(screens[Math.max(0, index - 1)]);

  if (index < 0) return { status: 400 };
  const screen = screens[index];
  const checked = validateScreenAnswers(screen, data);
  if (!checked.ok) return screenResponse(screen, { error_message: checked.message });

  if (!lastScreen) {
    await store.saveAnswers(session.id, checked.values);
    return screenResponse(screens[index + 1]);
  }

  const success = (answers: FormAnswers): FormsExchangeResult => {
    const params: Record<string, unknown> = { flow_token: flowToken };
    for (const field of screens.flatMap(screenInputFields)) {
      if (answers[field.id] !== undefined) params[field.id] = answers[field.id];
    }
    return { status: 200, body: { screen: FORMS_SUCCESS_SCREEN, data: { extension_message_response: { params } } } };
  };
  // Retry of a final submission that already completed: answer it again
  // without completing twice, so WhatsApp still delivers the reply.
  if (session.completed) return success({ ...session.answers, ...checked.values });

  // Last screen: every earlier screen must also hold up, whatever order the
  // customer took. A screen that no longer validates is shown again.
  const combined = { ...session.answers, ...checked.values };
  for (const earlier of screens.slice(0, -1)) {
    const again = validateScreenAnswers(earlier, combined);
    if (!again.ok) return screenResponse(earlier, { error_message: again.message });
  }
  const answers = await store.complete(session.id, checked.values);
  if (answers) return success(answers);
  // A concurrent duplicate completed it first: replay that completion.
  const current = await store.find(flowToken);
  if (!current || current.expired || !current.completed || current.id !== session.id) return { status: 427 };
  return success({ ...current.answers, ...checked.values });
}
