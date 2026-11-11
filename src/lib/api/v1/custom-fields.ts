// Stage 5 (5G): custom fields on the public API contact endpoints.
//
// GET /api/v1/contacts/{id} adds `custom_fields`, an object keyed by each
// field's name (the "key" integrators use) with the contact's value or null.
// PATCH accepts the same object: a string sets the value (through the shared
// contact field writer, so automations see the change), null clears it. A key
// matches a field by name (trimmed, case-insensitive) or by field id; an
// unknown or ambiguous key refuses the whole request before anything is
// written. Only this workspace's fields are ever read or written.

import type { DataClient } from '@/lib/data/types';
import { writeContactField } from '@/lib/contacts/field-write';

export const CUSTOM_FIELD_PATCH_LIMITS = { keys: 50, value: 1_000 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FieldRow { id: string; field_name: string }

export class CustomFieldInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomFieldInputError';
  }
}

async function workspaceFields(db: DataClient, accountId: string): Promise<FieldRow[]> {
  const { data, error } = await db.from('custom_fields').select('id, field_name').eq('account_id', accountId)
    .order('created_at', { ascending: true }).order('id', { ascending: true });
  if (error) throw new Error('Custom field lookup failed');
  return (data ?? []) as FieldRow[];
}

const norm = (name: string) => name.trim().toLowerCase();

/**
 * The field a key names: by id, else by name. Null when unknown; 'ambiguous'
 * when two fields share the name (the caller should use the id).
 */
export function resolveFieldKey(key: string, fields: readonly FieldRow[]): FieldRow | null | 'ambiguous' {
  if (UUID.test(key)) return fields.find((f) => f.id.toLowerCase() === key.toLowerCase()) ?? null;
  const matches = fields.filter((f) => norm(f.field_name) === norm(key));
  if (matches.length > 1) return 'ambiguous';
  return matches[0] ?? null;
}

/** The contact's custom fields by name (the first field wins when two share a name). */
export async function readContactCustomFields(db: DataClient, accountId: string, contactId: string): Promise<Record<string, string | null>> {
  const fields = await workspaceFields(db, accountId);
  if (!fields.length) return {};
  const { data, error } = await db.from('contact_custom_values').select('custom_field_id, value')
    .eq('account_id', accountId).eq('contact_id', contactId);
  if (error) throw new Error('Custom field value lookup failed');
  const values = new Map(((data ?? []) as { custom_field_id: string; value: string | null }[]).map((v) => [v.custom_field_id, v.value]));
  const out: Record<string, string | null> = {};
  for (const field of fields) if (!(field.field_name in out)) out[field.field_name] = values.get(field.id) ?? null;
  return out;
}

/** Validates a PATCH `custom_fields` object into field id -> value (null clears). Throws CustomFieldInputError. */
export function parseCustomFieldPatch(value: unknown, fields: readonly FieldRow[]): Map<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CustomFieldInputError("'custom_fields' must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > CUSTOM_FIELD_PATCH_LIMITS.keys) throw new CustomFieldInputError(`At most ${CUSTOM_FIELD_PATCH_LIMITS.keys} custom fields per request`);
  const out = new Map<string, string | null>();
  for (const [key, raw] of entries) {
    const field = resolveFieldKey(key, fields);
    if (field === 'ambiguous') throw new CustomFieldInputError(`Two custom fields are named '${key.slice(0, 60)}'; use the field id`);
    if (!field) throw new CustomFieldInputError(`Unknown custom field '${key.slice(0, 60)}'`);
    if (raw !== null && (typeof raw !== 'string' || raw.length > CUSTOM_FIELD_PATCH_LIMITS.value))
      throw new CustomFieldInputError(`Custom field '${key.slice(0, 60)}' must be a string of at most ${CUSTOM_FIELD_PATCH_LIMITS.value} characters, or null`);
    out.set(field.id, raw as string | null);
  }
  return out;
}

/** Resolves a PATCH `custom_fields` object against this workspace's fields. Throws CustomFieldInputError; writes nothing. */
export async function prepareCustomFieldPatch(db: DataClient, accountId: string, value: unknown): Promise<Map<string, string | null>> {
  return parseCustomFieldPatch(value, await workspaceFields(db, accountId));
}

/** Writes a prepared patch for a contact already verified to be this workspace's. */
export async function applyCustomFieldPatch(db: DataClient, accountId: string, contactId: string,
  patch: ReadonlyMap<string, string | null>): Promise<void> {
  for (const [fieldId, next] of patch) {
    if (next === null) {
      const { error } = await db.from('contact_custom_values').delete().eq('account_id', accountId)
        .eq('contact_id', contactId).eq('custom_field_id', fieldId);
      if (error) throw new Error('Custom field clear failed');
    } else if (!(await writeContactField(db, accountId, contactId, `custom:${fieldId}`, next))) {
      throw new CustomFieldInputError('Custom field not found');
    }
  }
}
