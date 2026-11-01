// ============================================================
// Audience filter engine: one typed filter, compiled to a
// parameterized SQL condition over `contacts c`. The browser only
// ever sends this JSON shape; field names map to fixed columns and
// every value is a bound parameter.
// ============================================================

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { TenantTransaction } from '@/lib/db/tenant';
import { CAMPAIGN_OUTCOMES, OUTCOME_STATUSES } from './outcomes';
import { requireFeature } from '@/lib/billing/entitlements';

const uuid = z.string().uuid();
const text = z.string().trim().max(1024);

const condition = z.discriminatedUnion('field', [
  z.object({ field: z.literal('tags'), op: z.enum(['has_any', 'has_none']), tagIds: z.array(uuid).min(1).max(50) }).strict(),
  z.object({ field: z.literal('list'), op: z.enum(['in_any', 'in_none']), listIds: z.array(uuid).min(1).max(50) }).strict(),
  // Retargeting: how a contact fared in one earlier campaign.
  z.object({ field: z.literal('campaign'), broadcastId: uuid, op: z.enum(CAMPAIGN_OUTCOMES) }).strict(),
  z.object({
    field: z.literal('custom_field'),
    fieldId: uuid,
    op: z.enum(['is', 'is_not', 'contains', 'is_empty', 'is_not_empty']),
    value: text.optional(),
  }).strict(),
  z.object({
    field: z.enum(['name', 'email', 'company', 'phone']),
    op: z.enum(['contains', 'is_empty', 'is_not_empty']),
    value: text.optional(),
  }).strict(),
  z.object({ field: z.literal('created_at'), op: z.enum(['before', 'after']), value: z.string().date() }).strict(),
  z.object({ field: z.enum(['opted_out', 'blocked']), op: z.literal('is'), value: z.boolean() }).strict(),
]).superRefine((c, ctx) => {
  const needsValue = ['is', 'is_not', 'contains'].includes(c.op) && c.field !== 'opted_out' && c.field !== 'blocked';
  if (needsValue && !('value' in c && typeof c.value === 'string' && c.value.length > 0))
    ctx.addIssue({ code: 'custom', message: 'This condition needs a value' });
});

/** All conditions must match (AND). */
export const audienceFilterSchema = z.object({ conditions: z.array(condition).min(1).max(20) }).strict();
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;
export type AudienceCondition = AudienceFilter['conditions'][number];

const ids = (values: string[]) =>
  Prisma.sql`SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)`;
const like = (value: string) => `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const COLUMNS = { name: Prisma.sql`c.name`, email: Prisma.sql`c.email`, company: Prisma.sql`c.company`, phone: Prisma.sql`c.phone` };

function compileCondition(accountId: string, c: AudienceCondition): Prisma.Sql {
  switch (c.field) {
    case 'tags': {
      const tagged = Prisma.sql`EXISTS(SELECT 1 FROM contact_tags t WHERE t.account_id=${accountId}::uuid AND t.contact_id=c.id AND t.tag_id IN (${ids(c.tagIds)}))`;
      return c.op === 'has_any' ? tagged : Prisma.sql`NOT ${tagged}`;
    }
    case 'list': {
      const member = Prisma.sql`EXISTS(SELECT 1 FROM contact_list_members m WHERE m.account_id=${accountId}::uuid AND m.contact_id=c.id AND m.list_id IN (${ids(c.listIds)}))`;
      return c.op === 'in_any' ? member : Prisma.sql`NOT ${member}`;
    }
    case 'campaign': {
      const outcome = Prisma.sql`EXISTS(SELECT 1 FROM broadcast_recipients r WHERE r.account_id=${accountId}::uuid AND r.contact_id=c.id
        AND r.broadcast_id=${c.broadcastId}::uuid AND r.status IN (${Prisma.join([...OUTCOME_STATUSES[c.op]])}))`;
      // A deleted campaign must match nobody, or "did not receive X" would match every contact.
      const exists = Prisma.sql`EXISTS(SELECT 1 FROM broadcasts b WHERE b.account_id=${accountId}::uuid AND b.id=${c.broadcastId}::uuid)`;
      return c.op === 'not_received' ? Prisma.sql`(${exists} AND NOT ${outcome})` : outcome;
    }
    case 'custom_field': {
      const value = Prisma.sql`(SELECT v.value FROM contact_custom_values v WHERE v.account_id=${accountId}::uuid AND v.contact_id=c.id AND v.custom_field_id=${c.fieldId}::uuid)`;
      if (c.op === 'is') return Prisma.sql`${value} = ${c.value}`;
      if (c.op === 'is_not') return Prisma.sql`${value} IS DISTINCT FROM ${c.value}`;
      if (c.op === 'contains') return Prisma.sql`${value} ILIKE ${like(c.value!)}`;
      return c.op === 'is_empty' ? Prisma.sql`COALESCE(${value},'') = ''` : Prisma.sql`COALESCE(${value},'') <> ''`;
    }
    case 'name':
    case 'email':
    case 'company':
    case 'phone': {
      const column = COLUMNS[c.field];
      if (c.op === 'contains') return Prisma.sql`${column} ILIKE ${like(c.value!)}`;
      return c.op === 'is_empty' ? Prisma.sql`COALESCE(${column},'') = ''` : Prisma.sql`COALESCE(${column},'') <> ''`;
    }
    case 'created_at':
      return c.op === 'before'
        ? Prisma.sql`c.created_at < ${c.value}::date`
        : Prisma.sql`c.created_at >= (${c.value}::date + 1)`;
    case 'opted_out':
      return c.value ? Prisma.sql`c.opted_out_at IS NOT NULL` : Prisma.sql`c.opted_out_at IS NULL`;
    case 'blocked':
      return c.value ? Prisma.sql`c.blocked_at IS NOT NULL` : Prisma.sql`c.blocked_at IS NULL`;
  }
}

/** A WHERE condition over `contacts c`, always scoped to the account. */
export function compileAudienceFilter(accountId: string, filter: AudienceFilter): Prisma.Sql {
  return Prisma.join(
    [Prisma.sql`c.account_id=${accountId}::uuid`, ...filter.conditions.map((c) => compileCondition(accountId, c))],
    ' AND ',
  );
}

/** Tags, lists, campaigns and custom fields named by the filter must belong to the account. */
export async function assertFilterReferences(tx: TenantTransaction, accountId: string, filter: AudienceFilter): Promise<void> {
  const tagIds = [...new Set(filter.conditions.flatMap((c) => (c.field === 'tags' ? c.tagIds : [])))];
  const listIds = [...new Set(filter.conditions.flatMap((c) => (c.field === 'list' ? c.listIds : [])))];
  const fieldIds = [...new Set(filter.conditions.flatMap((c) => (c.field === 'custom_field' ? [c.fieldId] : [])))];
  const broadcastIds = [...new Set(filter.conditions.flatMap((c) => (c.field === 'campaign' ? [c.broadcastId] : [])))];
  if (broadcastIds.length) {
    await requireFeature(tx, accountId, 'retargeting');
    const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM broadcasts WHERE account_id=${accountId}::uuid AND id IN (${ids(broadcastIds)})`);
    if (found.length !== broadcastIds.length) throw new AudienceFilterError('Some campaigns in this filter are unavailable in this workspace');
  }
  if (listIds.length) {
    const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM contact_lists WHERE account_id=${accountId}::uuid AND id IN (${ids(listIds)})`);
    if (found.length !== listIds.length) throw new AudienceFilterError('Some lists in this filter are unavailable in this workspace');
  }
  if (tagIds.length) {
    const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM tags WHERE account_id=${accountId}::uuid AND id IN (${ids(tagIds)})`);
    if (found.length !== tagIds.length) throw new AudienceFilterError('Some tags in this filter are unavailable in this workspace');
  }
  if (fieldIds.length) {
    const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM custom_fields WHERE account_id=${accountId}::uuid AND id IN (${ids(fieldIds)})`);
    if (found.length !== fieldIds.length) throw new AudienceFilterError('Some custom fields in this filter are unavailable in this workspace');
  }
}

/** Invalid filter input; the message is safe to show (HTTP 400). */
export class AudienceFilterError extends Error {}

export function parseAudienceFilter(input: unknown): AudienceFilter {
  const parsed = audienceFilterSchema.safeParse(input);
  if (!parsed.success) throw new AudienceFilterError(parsed.error.issues[0]?.message ?? 'Invalid audience filter');
  return parsed.data;
}
