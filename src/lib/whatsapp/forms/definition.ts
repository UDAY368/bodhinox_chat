/**
 * Pure validation for WhatsApp form definitions, run before every save and
 * before compiling to Flow JSON so an invalid form fails here with a
 * field-level error instead of as an opaque Meta validation error.
 *
 * Limits follow Meta's Flow JSON component limits (TextInput label 20,
 * helper-text 80, TextHeading 80, TextBody 4096, OptIn label 120, ...),
 * tightened where our builder keeps things simple (options 1-20).
 */

import { getT } from '@/lib/i18n/translate';
import {
  FORM_CHOICE_FIELD_TYPES,
  FORM_FIELD_TYPES,
  FORM_TEXT_FIELD_TYPES,
  type FormDefinition,
  type FormField,
  type FormFieldType,
  type FormSaveTo,
  type FormScreen,
  type FormValidationError,
} from './types';

const t = getT('Validation.forms');

export const FORM_LIMITS = {
  minScreens: 1,
  maxScreens: 10,
  minFieldsPerScreen: 1,
  maxFieldsPerScreen: 20,
  screenTitleMax: 30,
  buttonLabelMax: 30,
  helperMax: 80,
  minOptions: 1,
  maxOptions: 20,
  optionTitleMax: 30,
  successMessageMax: 1024,
  /** Meta TextInput accepts at most 80 characters; TextArea 600. */
  textInputMaxChars: 80,
  textAreaMaxChars: 600,
  screenIdRegex: /^[A-Z][A-Z0-9_]{0,29}$/,
  fieldIdRegex: /^[a-z][a-z0-9_]{0,39}$/,
  optionIdRegex: /^[A-Za-z0-9_]{1,40}$/,
} as const;

/** Label (or display text) limit per field type, from Meta's component limits. */
export const FORM_LABEL_MAX: Record<FormFieldType, number> = {
  heading: 80,
  paragraph: 4096,
  short_text: 20,
  long_text: 20,
  email: 20,
  phone: 20,
  number: 20,
  date: 40,
  dropdown: 20,
  radio: 30,
  checkboxes: 30,
  opt_in: 120,
};

/**
 * Names Meta or our response handling already use in the submission payload.
 * `error` would make the endpoint read a screen's values as Meta's error
 * notification; `error_message` is the key screen responses carry errors in.
 */
const RESERVED_FIELD_IDS = new Set(['flow_token', 'screen', 'data', 'action', 'version', 'error', 'error_message']);
const TEXT_INPUT_TYPES: readonly FormFieldType[] = ['short_text', 'email', 'phone', 'number'];
const CONTACT_FIELDS = new Set(['name', 'email', 'company']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FormDefinitionResult =
  | { ok: true; definition: FormDefinition }
  | { ok: false; errors: FormValidationError[] };

export function isInputField(type: FormFieldType): boolean {
  return !FORM_TEXT_FIELD_TYPES.includes(type);
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optionalText = (value: unknown): string | undefined => text(value) || undefined;
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function normaliseSaveTo(value: unknown): FormSaveTo | null {
  const raw = record(value);
  if (!raw) return null;
  if (raw.kind === 'contact_field') return { kind: 'contact_field', field: text(raw.field) as 'name' };
  if (raw.kind === 'custom_field') return { kind: 'custom_field', field_id: text(raw.field_id) };
  return { kind: text(raw.kind) } as unknown as FormSaveTo;
}

function normaliseField(value: unknown): FormField {
  const raw = record(value) ?? {};
  const type = text(raw.type) as FormFieldType;
  const field: FormField = { id: text(raw.id), type, label: text(raw.label) };
  if (raw.required !== undefined) field.required = raw.required === true;
  const helper = optionalText(raw.helper);
  if (helper !== undefined) field.helper = helper;
  if (Array.isArray(raw.options)) {
    field.options = raw.options.map((option) => {
      const o = record(option) ?? {};
      return { id: text(o.id), title: text(o.title) };
    });
  }
  const min = optionalNumber(raw.min);
  const max = optionalNumber(raw.max);
  if (min !== undefined) field.min = min;
  if (max !== undefined) field.max = max;
  if (raw.save_to !== undefined) field.save_to = normaliseSaveTo(raw.save_to);
  return field;
}

/**
 * Trims every string, drops empty optional text and coerces the shape so the
 * validator (and the compiler) see one canonical form. Never throws; unknown
 * input becomes an empty definition that then fails validation.
 */
export function normaliseFormDefinition(input: unknown): FormDefinition {
  const raw = record(input) ?? {};
  const screens = Array.isArray(raw.screens) ? raw.screens : [];
  const definition: FormDefinition = {
    version: raw.version === undefined ? 1 : (raw.version as 1),
    screens: screens.map((screen): FormScreen => {
      const s = record(screen) ?? {};
      return {
        id: text(s.id),
        title: text(s.title),
        fields: Array.isArray(s.fields) ? s.fields.map(normaliseField) : [],
        button_label: text(s.button_label),
      };
    }),
  };
  const success = optionalText(raw.success_message);
  if (success !== undefined) definition.success_message = success;
  return definition;
}

export interface EmptyFormLabels {
  title: string;
  field: string;
  button: string;
}

/** A one-screen, one-question starting point for the builder. */
export function emptyFormDefinition(labels?: EmptyFormLabels): FormDefinition {
  const l = labels ?? { title: t('defaults.screenTitle'), field: t('defaults.fieldLabel'), button: t('defaults.buttonLabel') };
  return {
    version: 1,
    screens: [{
      id: 'SCREEN_1',
      title: l.title,
      fields: [{ id: 'name', type: 'short_text', label: l.field, required: true }],
      button_label: l.button,
    }],
  };
}

function validateBounds(field: FormField, path: string, errors: FormValidationError[]) {
  const { min, max, type } = field;
  if (min === undefined && max === undefined) return;
  // A TextArea takes only a maximum length (Meta `max-length`).
  const allowed = TEXT_INPUT_TYPES.includes(type) || type === 'checkboxes' || (type === 'long_text' && min === undefined);
  if (!allowed) {
    errors.push({ path: `${path}.${min !== undefined ? 'min' : 'max'}`, message: t('boundsNotAllowed') });
    return;
  }
  for (const [key, value] of [['min', min], ['max', max]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      errors.push({ path: `${path}.${key}`, message: t('boundsInvalid') });
      return;
    }
  }
  if (min !== undefined && max !== undefined && min > max) {
    errors.push({ path: `${path}.min`, message: t('boundsOrder') });
    return;
  }
  const ceiling = type === 'long_text' ? FORM_LIMITS.textAreaMaxChars
    : type === 'checkboxes' ? (field.options?.length ?? 0)
      : FORM_LIMITS.textInputMaxChars;
  if ((max !== undefined && max > ceiling) || (min !== undefined && min > ceiling)) {
    errors.push({ path: `${path}.${max !== undefined && max > ceiling ? 'max' : 'min'}`, message: t('boundsTooHigh', { max: ceiling }) });
  }
  if (type === 'checkboxes' && max === 0) errors.push({ path: `${path}.max`, message: t('boundsInvalid') });
}

function validateSaveTo(field: FormField, path: string, errors: FormValidationError[]) {
  const saveTo = field.save_to;
  if (!saveTo) return;
  // Text fields collect nothing and a checkbox group answers with a list.
  if (!isInputField(field.type) || field.type === 'checkboxes' || field.type === 'opt_in') {
    errors.push({ path: `${path}.save_to`, message: t('saveToNotAllowed') });
    return;
  }
  const valid = saveTo.kind === 'contact_field' ? CONTACT_FIELDS.has(saveTo.field)
    : saveTo.kind === 'custom_field' ? UUID.test(saveTo.field_id) : false;
  if (!valid) errors.push({ path: `${path}.save_to`, message: t('saveToInvalid') });
}

function validateField(field: FormField, path: string, seenIds: Set<string>, errors: FormValidationError[]) {
  if (!FORM_FIELD_TYPES.includes(field.type)) {
    errors.push({ path: `${path}.type`, message: t('fieldType') });
    return;
  }
  if (!FORM_LIMITS.fieldIdRegex.test(field.id)) errors.push({ path: `${path}.id`, message: t('fieldId') });
  else if (RESERVED_FIELD_IDS.has(field.id)) errors.push({ path: `${path}.id`, message: t('fieldIdReserved', { id: field.id }) });
  else if (seenIds.has(field.id)) errors.push({ path: `${path}.id`, message: t('fieldIdDuplicate', { id: field.id }) });
  seenIds.add(field.id);

  const labelMax = FORM_LABEL_MAX[field.type];
  if (!field.label) errors.push({ path: `${path}.label`, message: t('labelRequired') });
  else if (field.label.length > labelMax) errors.push({ path: `${path}.label`, message: t('labelTooLong', { max: labelMax }) });

  const input = isInputField(field.type);
  if (!input && field.required) errors.push({ path: `${path}.required`, message: t('requiredNotAllowed') });
  if (field.helper !== undefined) {
    // Only text inputs and the date picker render helper text in Meta Flows.
    const helperAllowed = TEXT_INPUT_TYPES.includes(field.type) || field.type === 'long_text' || field.type === 'date';
    if (!helperAllowed) errors.push({ path: `${path}.helper`, message: t('helperNotAllowed') });
    else if (field.helper.length > FORM_LIMITS.helperMax) {
      errors.push({ path: `${path}.helper`, message: t('helperTooLong', { max: FORM_LIMITS.helperMax }) });
    }
  }

  const choice = FORM_CHOICE_FIELD_TYPES.includes(field.type);
  if (!choice && field.options !== undefined && field.options.length > 0) {
    errors.push({ path: `${path}.options`, message: t('optionsNotAllowed') });
  }
  if (choice) {
    const options = field.options ?? [];
    if (options.length < FORM_LIMITS.minOptions || options.length > FORM_LIMITS.maxOptions) {
      errors.push({ path: `${path}.options`, message: t('optionsCount', { min: FORM_LIMITS.minOptions, max: FORM_LIMITS.maxOptions }) });
    }
    const optionIds = new Set<string>();
    options.forEach((option, index) => {
      const optionPath = `${path}.options.${index}`;
      if (!FORM_LIMITS.optionIdRegex.test(option.id)) errors.push({ path: `${optionPath}.id`, message: t('optionId') });
      else if (optionIds.has(option.id)) errors.push({ path: `${optionPath}.id`, message: t('optionIdDuplicate', { id: option.id }) });
      optionIds.add(option.id);
      if (!option.title) errors.push({ path: `${optionPath}.title`, message: t('optionTitleRequired') });
      else if (option.title.length > FORM_LIMITS.optionTitleMax) {
        errors.push({ path: `${optionPath}.title`, message: t('optionTitleTooLong', { max: FORM_LIMITS.optionTitleMax }) });
      }
    });
  }
  validateBounds(field, path, errors);
  validateSaveTo(field, path, errors);
}

/**
 * Validates (after normalising) a form definition. On success the returned
 * definition is the normalised one, which is what callers should store.
 */
export function validateFormDefinition(input: unknown): FormDefinitionResult {
  const errors: FormValidationError[] = [];
  if (!record(input)) return { ok: false, errors: [{ path: '', message: t('notObject') }] };
  const definition = normaliseFormDefinition(input);
  if (definition.version !== 1) errors.push({ path: 'version', message: t('version') });

  const { screens } = definition;
  if (screens.length < FORM_LIMITS.minScreens || screens.length > FORM_LIMITS.maxScreens) {
    errors.push({ path: 'screens', message: t('screensCount', { min: FORM_LIMITS.minScreens, max: FORM_LIMITS.maxScreens }) });
  }
  const screenIds = new Set<string>();
  const fieldIds = new Set<string>();
  let inputs = 0;
  screens.forEach((screen, s) => {
    const path = `screens.${s}`;
    if (!FORM_LIMITS.screenIdRegex.test(screen.id)) errors.push({ path: `${path}.id`, message: t('screenId') });
    else if (screenIds.has(screen.id)) errors.push({ path: `${path}.id`, message: t('screenIdDuplicate', { id: screen.id }) });
    screenIds.add(screen.id);
    if (!screen.title) errors.push({ path: `${path}.title`, message: t('screenTitleRequired') });
    else if (screen.title.length > FORM_LIMITS.screenTitleMax) {
      errors.push({ path: `${path}.title`, message: t('screenTitleTooLong', { max: FORM_LIMITS.screenTitleMax }) });
    }
    if (!screen.button_label) errors.push({ path: `${path}.button_label`, message: t('buttonLabelRequired') });
    else if (screen.button_label.length > FORM_LIMITS.buttonLabelMax) {
      errors.push({ path: `${path}.button_label`, message: t('buttonLabelTooLong', { max: FORM_LIMITS.buttonLabelMax }) });
    }
    if (screen.fields.length < FORM_LIMITS.minFieldsPerScreen || screen.fields.length > FORM_LIMITS.maxFieldsPerScreen) {
      errors.push({ path: `${path}.fields`, message: t('fieldsCount', { min: FORM_LIMITS.minFieldsPerScreen, max: FORM_LIMITS.maxFieldsPerScreen }) });
    }
    screen.fields.forEach((field, f) => {
      if (FORM_FIELD_TYPES.includes(field.type) && isInputField(field.type)) inputs += 1;
      validateField(field, `${path}.fields.${f}`, fieldIds, errors);
    });
  });
  if (screens.length > 0 && inputs === 0) errors.push({ path: 'screens', message: t('noInputs') });
  if (definition.success_message !== undefined && definition.success_message.length > FORM_LIMITS.successMessageMax) {
    errors.push({ path: 'success_message', message: t('successTooLong', { max: FORM_LIMITS.successMessageMax }) });
  }
  return errors.length ? { ok: false, errors } : { ok: true, definition };
}
