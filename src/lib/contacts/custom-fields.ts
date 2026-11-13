// ============================================================
// Custom fields with types (Contacts > Custom fields). Any member lists them
// with how many contacts have a value and how many segments use them; admins
// create, rename, change a choice field's choices and delete. A field's type
// is fixed once it exists (the custom_fields_type_fixed trigger enforces it
// too). Deleting a field removes its values and its conditions from saved
// segments; a segment left with no condition would match everyone, so that
// delete is refused until the segment is edited. Changing a choice field's
// choices is refused (choice_in_segment, with the segment names) while a saved
// segment filters on a removed choice, until the admin confirms; the confirmed
// save removes those conditions (the same rule as a delete). Creating and
// renaming are serialized per workspace with an advisory lock, and names are
// compared case-insensitively. Runs in the caller's tenant transaction on the
// app role (RLS: custom_fields written by admins).
// ============================================================

import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import {
  CUSTOM_FIELD_TYPES,
  MAX_FIELD_NAME,
  RESERVED_FIELD_NAMES,
  checkChoices,
  fieldChoices,
  type ChoicesProblem,
  type CustomFieldType,
} from './custom-field-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CustomFieldSummary {
  id: string;
  field_name: string;
  field_type: CustomFieldType;
  choices: string[];
  /** Contacts with a value. */
  filled: number;
  /** Saved segments with a condition on this field. */
  segments: number;
  created_at: string;
}

export type CustomFieldErrorCode = 'invalid' | 'name_required' | 'name_too_long' | 'name_taken' | 'name_reserved' | 'invalid_type'
  | ChoicesProblem | 'not_found' | 'segment_needs_field' | 'choice_in_segment';

export class CustomFieldError extends Error {
  constructor(readonly code: CustomFieldErrorCode, readonly segments: string[] = []) {
    super(code);
  }
  get status(): number {
    return this.code === 'not_found' ? 404
      : this.code === 'name_taken' || this.code === 'segment_needs_field' || this.code === 'choice_in_segment' ? 409 : 400;
  }
}

/** A route's answer for a refused change (the code, and the segments that block a delete). */
export function customFieldError(error: unknown): NextResponse {
  if (error instanceof CustomFieldError)
    return NextResponse.json({ error: error.code, ...(error.segments.length ? { segments: error.segments } : {}) }, { status: error.status });
  return toErrorResponse(error);
}

type Row = { id: string; field_name: string; field_type: string; field_options: unknown; filled: number; segments: number; created_at: Date | null };

const SUMMARY = (accountId: string) => Prisma.sql`
  SELECT f.id::text, f.field_name, f.field_type, f.field_options, f.created_at,
    (SELECT count(*)::int FROM contact_custom_values v WHERE v.account_id=f.account_id AND v.custom_field_id=f.id AND COALESCE(v.value,'')<>'') AS filled,
    (SELECT count(*)::int FROM segments s WHERE s.account_id=f.account_id
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.filter->'conditions','[]'::jsonb)) c
        WHERE c->>'field'='custom_field' AND c->>'fieldId'=f.id::text)) AS segments
  FROM custom_fields f WHERE f.account_id=${accountId}::uuid`;

function toSummary(row: Row): CustomFieldSummary {
  const field_type = (CUSTOM_FIELD_TYPES as readonly string[]).includes(row.field_type) ? (row.field_type as CustomFieldType) : 'text';
  return {
    id: row.id,
    field_name: row.field_name,
    field_type,
    choices: fieldChoices({ field_type, field_options: row.field_options }),
    filled: row.filled,
    segments: row.segments,
    created_at: row.created_at ? row.created_at.toISOString() : '',
  };
}

export function listCustomFields(ctx: TenantContext): Promise<CustomFieldSummary[]> {
  return withTenant(ctx, async (tx) =>
    (await tx.$queryRaw<Row[]>(Prisma.sql`${SUMMARY(ctx.accountId)} ORDER BY lower(f.field_name), f.id`)).map(toSummary));
}

function parseName(input: unknown): string {
  if (typeof input !== 'string') throw new CustomFieldError('name_required');
  const name = input.trim().replace(/\s+/g, ' ');
  if (!name) throw new CustomFieldError('name_required');
  if (name.length > MAX_FIELD_NAME) throw new CustomFieldError('name_too_long');
  if (RESERVED_FIELD_NAMES.includes(name.toLowerCase())) throw new CustomFieldError('name_reserved');
  return name;
}

function parseChoiceList(input: unknown): string[] {
  if (!Array.isArray(input) || input.some((c) => typeof c !== 'string')) throw new CustomFieldError('too_few');
  const seen = new Set<string>();
  const choices = (input as string[]).map((c) => c.trim()).filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
  const problem = checkChoices(choices);
  if (problem) throw new CustomFieldError(problem);
  return choices;
}

/** One writer of field names per workspace at a time, so two creates or renames cannot both pass the name check. */
async function lockFieldNames(tx: TenantTransaction, accountId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'custom_field_names:' + accountId}))`;
}

type SegmentCondition = { field?: string; fieldId?: string; op?: string; value?: unknown };
type SegmentRow = { id: string; name: string; filter: { conditions?: SegmentCondition[] } };

/**
 * A saved segment's conditions on this field that test for a value no longer among its choices
 * ("is" / "is not" a removed choice). Pure; unit-tested.
 */
export function staleChoiceConditions(filter: SegmentRow['filter'] | null | undefined, fieldId: string, choices: readonly string[]): SegmentCondition[] {
  return (filter?.conditions ?? []).filter((c) => c.field === 'custom_field' && c.fieldId === fieldId
    && (c.op === 'is' || c.op === 'is_not') && typeof c.value === 'string' && !choices.includes(c.value));
}

function body(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CustomFieldError('invalid');
  return input as Record<string, unknown>;
}

export async function createCustomField(ctx: TenantContext, input: unknown): Promise<CustomFieldSummary> {
  const data = body(input);
  const name = parseName(data.name);
  if (typeof data.type !== 'string' || !(CUSTOM_FIELD_TYPES as readonly string[]).includes(data.type)) throw new CustomFieldError('invalid_type');
  const type = data.type as CustomFieldType;
  const choices = type === 'choice' ? parseChoiceList(data.choices) : null;
  return withTenant(ctx, async (tx) => {
    await lockFieldNames(tx, ctx.accountId);
    const taken = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM custom_fields WHERE account_id=${ctx.accountId}::uuid AND lower(field_name)=lower(${name}) LIMIT 1`;
    if (taken.length) throw new CustomFieldError('name_taken');
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO custom_fields(account_id, user_id, field_name, field_type, field_options)
      VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, ${name}, ${type}, ${choices ? JSON.stringify(choices) : null}::jsonb)
      RETURNING id::text`;
    const [row] = await tx.$queryRaw<Row[]>(Prisma.sql`${SUMMARY(ctx.accountId)} AND f.id=${rows[0].id}::uuid`);
    return toSummary(row);
  });
}

/**
 * Renames a field and, for a choice field, replaces its choices. Values that
 * are no longer a choice are cleared (the contacts keep every other value).
 * Saved segments that filter on a removed choice block the change
 * (choice_in_segment, with their names) unless `confirm: true` is sent; then
 * those conditions are removed, and a segment that would be left with none
 * is refused (segment_needs_field) as a delete is.
 */
export async function updateCustomField(ctx: TenantContext, id: string, input: unknown): Promise<CustomFieldSummary> {
  if (!UUID.test(id)) throw new CustomFieldError('not_found');
  const data = body(input);
  if ('type' in data) throw new CustomFieldError('invalid_type');
  const name = 'name' in data ? parseName(data.name) : null;
  return withTenant(ctx, async (tx) => {
    if (name) await lockFieldNames(tx, ctx.accountId);
    const found = await tx.$queryRaw<{ field_type: string }[]>`
      SELECT field_type FROM custom_fields WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
    if (!found[0]) throw new CustomFieldError('not_found');
    const choices = 'choices' in data ? (found[0].field_type === 'choice' ? parseChoiceList(data.choices) : (() => { throw new CustomFieldError('invalid_type'); })()) : null;
    if (name) {
      const taken = await tx.$queryRaw<{ ok: number }[]>`
        SELECT 1 AS ok FROM custom_fields WHERE account_id=${ctx.accountId}::uuid AND lower(field_name)=lower(${name}) AND id<>${id}::uuid LIMIT 1`;
      if (taken.length) throw new CustomFieldError('name_taken');
      await tx.$executeRaw`UPDATE custom_fields SET field_name=${name} WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    }
    if (choices) {
      const segments = await tx.$queryRaw<SegmentRow[]>`
        SELECT id::text, name, filter FROM segments WHERE account_id=${ctx.accountId}::uuid
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(filter->'conditions','[]'::jsonb)) c
            WHERE c->>'field'='custom_field' AND c->>'fieldId'=${id})
        FOR UPDATE`;
      const affected = segments
        .map((s) => ({ segment: s, stale: staleChoiceConditions(s.filter, id, choices) }))
        .filter((a) => a.stale.length > 0);
      if (affected.length && data.confirm !== true) throw new CustomFieldError('choice_in_segment', affected.map((a) => a.segment.name));
      const emptied = affected.filter((a) => a.stale.length === (a.segment.filter.conditions ?? []).length);
      if (emptied.length) throw new CustomFieldError('segment_needs_field', emptied.map((a) => a.segment.name));
      for (const { segment, stale } of affected) {
        const filter = { ...segment.filter, conditions: (segment.filter.conditions ?? []).filter((c) => !stale.includes(c)) };
        await tx.$executeRaw`UPDATE segments SET filter=${JSON.stringify(filter)}::jsonb WHERE account_id=${ctx.accountId}::uuid AND id=${segment.id}::uuid`;
      }
      await tx.$executeRaw`UPDATE custom_fields SET field_options=${JSON.stringify(choices)}::jsonb WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_custom_values WHERE account_id=${ctx.accountId}::uuid AND custom_field_id=${id}::uuid
        AND NOT (value = ANY(${choices}::text[]))`;
    }
    const [row] = await tx.$queryRaw<Row[]>(Prisma.sql`${SUMMARY(ctx.accountId)} AND f.id=${id}::uuid`);
    return toSummary(row);
  });
}

/**
 * Deletes a field, its values and its conditions in saved segments. Refused
 * (segment_needs_field, with the segment names) when a segment has no other
 * condition, since an empty segment would match every contact.
 */
export async function deleteCustomField(ctx: TenantContext, id: string): Promise<{ values: number; segments: number }> {
  if (!UUID.test(id)) throw new CustomFieldError('not_found');
  return withTenant(ctx, async (tx) => {
    const found = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM custom_fields WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
    if (!found[0]) throw new CustomFieldError('not_found');
    const segments = await tx.$queryRaw<{ id: string; name: string; filter: { conditions?: { field?: string; fieldId?: string }[] } }[]>`
      SELECT id::text, name, filter FROM segments WHERE account_id=${ctx.accountId}::uuid
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(filter->'conditions','[]'::jsonb)) c
          WHERE c->>'field'='custom_field' AND c->>'fieldId'=${id})
      FOR UPDATE`;
    const uses = (c: { field?: string; fieldId?: string }) => c.field === 'custom_field' && c.fieldId === id;
    const emptied = segments.filter((s) => (s.filter.conditions ?? []).every(uses));
    if (emptied.length) throw new CustomFieldError('segment_needs_field', emptied.map((s) => s.name));
    for (const s of segments) {
      const filter = { ...s.filter, conditions: (s.filter.conditions ?? []).filter((c) => !uses(c)) };
      await tx.$executeRaw`UPDATE segments SET filter=${JSON.stringify(filter)}::jsonb WHERE account_id=${ctx.accountId}::uuid AND id=${s.id}::uuid`;
    }
    const values = await tx.$executeRaw`DELETE FROM contact_custom_values WHERE account_id=${ctx.accountId}::uuid AND custom_field_id=${id}::uuid`;
    await tx.$executeRaw`DELETE FROM custom_fields WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    return { values, segments: segments.length };
  });
}
