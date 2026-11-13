// Typed custom fields (20261121000200). A field is text, number, date or
// choice; its values stay text in contact_custom_values: a number as a plain
// decimal string, a date as YYYY-MM-DD, a choice as one of the field's choices.
// Every write path that knows the field (profile, bulk set, import) checks the
// value here. Text fields, every field made before types existed, take any text.
// Shared by the browser and the server; no database access.

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'choice'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Longest stored value (MAX_BULK_FIELD_VALUE in bulk.ts). */
export const MAX_CUSTOM_VALUE = 1000;
export const MAX_FIELD_NAME = 60;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 50;
export const MAX_CHOICE_LENGTH = 100;

export interface TypedField {
  field_type: string;
  field_options?: unknown;
}

export function fieldType(field: TypedField): CustomFieldType {
  return (CUSTOM_FIELD_TYPES as readonly string[]).includes(field.field_type) ? (field.field_type as CustomFieldType) : 'text';
}

/** A choice field's choices (an array of strings in field_options); [] for other types. */
export function fieldChoices(field: TypedField): string[] {
  if (fieldType(field) !== 'choice' || !Array.isArray(field.field_options)) return [];
  return field.field_options.filter((o): o is string => typeof o === 'string');
}

/** Choices typed one per line: trimmed, blank lines and repeats (case-insensitive) dropped. */
export function parseChoices(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const choice = line.trim();
    if (!choice || seen.has(choice.toLowerCase())) continue;
    seen.add(choice.toLowerCase());
    out.push(choice);
  }
  return out;
}

export type ChoicesProblem = 'too_few' | 'too_many' | 'too_long';

export function checkChoices(choices: string[]): ChoicesProblem | null {
  if (choices.length < MIN_CHOICES) return 'too_few';
  if (choices.length > MAX_CHOICES) return 'too_many';
  if (choices.some((c) => c.length > MAX_CHOICE_LENGTH)) return 'too_long';
  return null;
}

const NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export type ValueProblem = 'too_long' | 'not_a_number' | 'not_a_date' | 'not_a_choice';

/**
 * The value to store for a field, or the reason it is refused. An empty value
 * (after trimming) is '' and means "clear it". Numbers drop a leading '+' and
 * thousands separators are refused (1,000 is ambiguous across locales).
 */
export function normalizeFieldValue(field: TypedField, raw: string): { ok: true; value: string } | { ok: false; problem: ValueProblem } {
  const value = raw.trim();
  if (!value) return { ok: true, value: '' };
  if (value.length > MAX_CUSTOM_VALUE) return { ok: false, problem: 'too_long' };
  switch (fieldType(field)) {
    case 'number': {
      const n = value.replace(/^\+/, '');
      if (!NUMBER.test(n)) return { ok: false, problem: 'not_a_number' };
      return { ok: true, value: n.replace(/^(-?)0+(?=\d)/, '$1') };
    }
    case 'date':
      return isValidDate(value) ? { ok: true, value } : { ok: false, problem: 'not_a_date' };
    case 'choice': {
      const match = fieldChoices(field).find((c) => c.toLowerCase() === value.toLowerCase());
      return match ? { ok: true, value: match } : { ok: false, problem: 'not_a_choice' };
    }
    default:
      return { ok: true, value };
  }
}

/** Contacts' system fields a custom field name may not repeat (the profile shows both). */
export const RESERVED_FIELD_NAMES = ['name', 'phone', 'email', 'company', 'city', 'owner', 'instagram', 'tags', 'labels'];
