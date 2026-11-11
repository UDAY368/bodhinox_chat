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
import { STANDARD_WINDOW_MS } from '@/lib/instagram/window';

/** Boolean profile facts a segment can test; each maps to a fixed contact_channel_identities column. */
export const IG_SEGMENT_FACTS = ['follows_business', 'business_follows', 'is_verified'] as const;
const IG_FACT_COLUMNS = {
  follows_business: Prisma.sql`i.follows_business`,
  business_follows: Prisma.sql`i.business_follows`,
  is_verified: Prisma.sql`i.is_verified`,
};

const uuid = z.string().uuid();
const text = z.string().trim().max(1024);
/** A Meta object id (ad, lead form): digits only. */
const metaId = z.string().regex(/^\d{1,32}$/);

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
  // Click-to-WhatsApp ads: contacts who started a conversation from these ads (empty = any ad).
  z.object({ field: z.literal('ad'), op: z.enum(['clicked_any', 'clicked_none']), adIds: z.array(metaId).max(50) }).strict(),
  // Meta lead ads: contacts matched to a lead from these forms (empty = any form).
  z.object({ field: z.literal('lead_form'), op: z.enum(['submitted_any', 'submitted_none']), formIds: z.array(metaId).max(50) }).strict(),
  // Phase 11: contacts with (or without) an Instagram identity. Never a broadcast channel: campaigns still need a phone.
  z.object({ field: z.literal('instagram'), op: z.enum(['has_identity', 'has_no_identity']) }).strict(),
  // Stage 3: the Instagram profile facts stored on the identity (a contact with no Instagram identity matches none of these).
  z.object({ field: z.literal('instagram_profile'), fact: z.enum(IG_SEGMENT_FACTS), op: z.enum(['is_true', 'is_false', 'is_unknown']) }).strict(),
  z.object({ field: z.literal('instagram_followers'), op: z.enum(['at_least', 'at_most']), value: z.number().int().min(0).max(2_000_000_000) }).strict(),
  // In the 24-hour window: an Instagram conversation where the customer wrote within 24 hours. closed: has one, none in window.
  z.object({ field: z.literal('instagram_window'), op: z.enum(['open', 'closed']) }).strict(),
  // Stage 5: reachable on WhatsApp (the contact has a number; Instagram-only contacts have none).
  z.object({ field: z.literal('whatsapp'), op: z.enum(['has_number', 'has_no_number']) }).strict(),
  // Stage 5: the Instagram subscription. subscribed: an Instagram identity and no Instagram opt-out;
  // unsubscribed: opted out on Instagram (contacts.instagram_opted_out_at).
  z.object({ field: z.literal('instagram_subscription'), op: z.enum(['subscribed', 'unsubscribed']) }).strict(),
]).superRefine((c, ctx) => {
  const needsValue = ['is', 'is_not', 'contains'].includes(c.op) && c.field !== 'opted_out' && c.field !== 'blocked';
  if (needsValue && !('value' in c && typeof c.value === 'string' && c.value.length > 0))
    ctx.addIssue({ code: 'custom', message: 'This condition needs a value' });
});

/** How the conditions combine: every one (the default, and every filter saved before Stage 5) or any one. */
export const AUDIENCE_MATCH_MODES = ['all', 'any'] as const;
export type AudienceMatch = (typeof AUDIENCE_MATCH_MODES)[number];

/** The conditions must all match (AND), or with `match: 'any'` at least one (OR). */
export const audienceFilterSchema = z.object({
  conditions: z.array(condition).min(1).max(20),
  match: z.enum(AUDIENCE_MATCH_MODES).optional(),
}).strict();
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;
export type AudienceCondition = AudienceFilter['conditions'][number];

const ids = (values: string[]) =>
  Prisma.sql`SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)`;
/** Meta ids are text (digits), not uuids. */
const textIds = (values: string[]) =>
  Prisma.sql`SELECT value FROM jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)`;
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
    case 'ad': {
      // A stored click-to-WhatsApp referral from an ad; an empty list means any ad.
      const only = c.adIds.length ? Prisma.sql` AND r.source_id IN (${textIds(c.adIds)})` : Prisma.empty;
      const clicked = Prisma.sql`EXISTS(SELECT 1 FROM ad_referrals r WHERE r.account_id=${accountId}::uuid AND r.contact_id=c.id
        AND r.source_type='ad'${only})`;
      return c.op === 'clicked_any' ? clicked : Prisma.sql`NOT ${clicked}`;
    }
    case 'lead_form': {
      // A Meta lead matched to this contact; an empty list means any form.
      const only = c.formIds.length ? Prisma.sql` AND l.form_id IN (${textIds(c.formIds)})` : Prisma.empty;
      const submitted = Prisma.sql`EXISTS(SELECT 1 FROM meta_leads l WHERE l.account_id=${accountId}::uuid AND l.contact_id=c.id${only})`;
      return c.op === 'submitted_any' ? submitted : Prisma.sql`NOT ${submitted}`;
    }
    case 'instagram': {
      const identity = Prisma.sql`EXISTS(SELECT 1 FROM contact_channel_identities i WHERE i.account_id=${accountId}::uuid AND i.contact_id=c.id
        AND i.channel='instagram')`;
      return c.op === 'has_identity' ? identity : Prisma.sql`NOT ${identity}`;
    }
    case 'instagram_profile': {
      const test = c.op === 'is_true' ? Prisma.sql`${IG_FACT_COLUMNS[c.fact]} IS TRUE`
        : c.op === 'is_false' ? Prisma.sql`${IG_FACT_COLUMNS[c.fact]} IS FALSE` : Prisma.sql`${IG_FACT_COLUMNS[c.fact]} IS NULL`;
      return Prisma.sql`EXISTS(SELECT 1 FROM contact_channel_identities i WHERE i.account_id=${accountId}::uuid AND i.contact_id=c.id
        AND i.channel='instagram' AND ${test})`;
    }
    case 'instagram_followers':
      return Prisma.sql`EXISTS(SELECT 1 FROM contact_channel_identities i WHERE i.account_id=${accountId}::uuid AND i.contact_id=c.id
        AND i.channel='instagram' AND i.ig_follower_count ${c.op === 'at_least' ? Prisma.sql`>=` : Prisma.sql`<=`} ${c.value})`;
    case 'instagram_window': {
      const conversation = Prisma.sql`SELECT 1 FROM conversations v WHERE v.account_id=${accountId}::uuid AND v.contact_id=c.id AND v.channel='instagram'`;
      const open = Prisma.sql`EXISTS(${conversation} AND EXISTS(SELECT 1 FROM messages m WHERE m.account_id=v.account_id AND m.conversation_id=v.id
        AND m.sender_type='customer' AND m.created_at > now() - make_interval(secs => ${STANDARD_WINDOW_MS / 1000})))`;
      return c.op === 'open' ? open : Prisma.sql`(EXISTS(${conversation}) AND NOT ${open})`;
    }
    case 'whatsapp':
      return c.op === 'has_number' ? Prisma.sql`COALESCE(c.phone,'') <> ''` : Prisma.sql`COALESCE(c.phone,'') = ''`;
    case 'instagram_subscription': {
      if (c.op === 'unsubscribed') return Prisma.sql`c.instagram_opted_out_at IS NOT NULL`;
      return Prisma.sql`(c.instagram_opted_out_at IS NULL AND EXISTS(SELECT 1 FROM contact_channel_identities i
        WHERE i.account_id=${accountId}::uuid AND i.contact_id=c.id AND i.channel='instagram'))`;
    }
  }
}

/**
 * A WHERE condition over `contacts c`, always scoped to the account. With
 * `match: 'any'` the conditions are one parenthesised OR group, still inside
 * the account scope; a filter without conditions matches every contact.
 */
export function compileAudienceFilter(accountId: string, filter: AudienceFilter): Prisma.Sql {
  const scope = Prisma.sql`c.account_id=${accountId}::uuid`;
  const conditions = filter.conditions.map((c) => compileCondition(accountId, c));
  if (filter.match === 'any' && conditions.length > 1)
    return Prisma.sql`${scope} AND (${Prisma.join(conditions.map((c) => Prisma.sql`(${c})`), ' OR ')})`;
  return Prisma.join([scope, ...conditions], ' AND ');
}

/** Tags, lists, campaigns and custom fields named by the filter must belong to the account. */
export async function assertFilterReferences(tx: TenantTransaction, accountId: string, filter: AudienceFilter): Promise<void> {
  const tagIds = [...new Set(filter.conditions.flatMap((c) => (c.field === 'tags' ? c.tagIds : [])))];
  const listIds = [...new Set(filter.conditions.flatMap((c) => (c.field === 'list' ? c.listIds : [])))];
  const fieldIds = [...new Set(filter.conditions.flatMap((c) => (c.field === 'custom_field' ? [c.fieldId] : [])))];
  const broadcastIds = [...new Set(filter.conditions.flatMap((c) => (c.field === 'campaign' ? [c.broadcastId] : [])))];
  // Ad and lead-form conditions are retargeting too; their ids are Meta ids, not rows, so nothing is looked up.
  if (broadcastIds.length || filter.conditions.some((c) => c.field === 'ad' || c.field === 'lead_form'))
    await requireFeature(tx, accountId, 'retargeting');
  if (broadcastIds.length) {
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

/** The named segment is not in this workspace (or does not exist); routes answer 404. */
export class AudienceNotFoundError extends AudienceFilterError {}

export function parseAudienceFilter(input: unknown): AudienceFilter {
  const parsed = audienceFilterSchema.safeParse(input);
  if (!parsed.success) throw new AudienceFilterError(parsed.error.issues[0]?.message ?? 'Invalid audience filter');
  return parsed.data;
}
