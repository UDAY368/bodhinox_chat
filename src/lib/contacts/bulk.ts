// ============================================================
// Bulk contact actions on every contact matching the contacts page's
// current view (a segment, a list, a tag filter or none, plus the search
// box), not only the 25 rows on screen. The browser sends the view and the
// count it showed; the action runs only if the match count is still that
// number, so nobody deletes or tags more than they were shown. Runs in the
// caller's tenant transaction on the app role (RLS: agent and above).
//
// Stage 5 (5E): the view may also be narrowed by channel (has a WhatsApp
// number, has an Instagram identity) and to contacts subscribed on Instagram,
// and four more actions run on it: remove a tag, unsubscribe from Instagram,
// pause automations (on the contacts' conversations the member may see) and
// set a custom field. Like the bulk tag, none of them starts an automation
// (no tag_removed or field_changed event): one click must not start
// automations for thousands of contacts. Values are never logged.
// ============================================================

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { AudienceFilterError, AudienceNotFoundError, assertFilterReferences, compileAudienceFilter, type AudienceFilter } from '@/lib/audience/filter';
import { listFilter } from '@/lib/audience/lists';
import { contactSearchSql, loadSegmentFilter } from '@/lib/audience/segments';
import { PAUSE_MINUTES_CHOICES } from '@/lib/flows/types';
import { markExplicitPause } from '@/lib/inbox/automation-pause';
import { conversationVisibleSql } from '@/lib/inbox/inbox-scope';
import { loadPhoneMask, maskContactIdentifier, maskContactRow } from '@/lib/inbox/masking-apply';
import { normalizeFieldValue } from './custom-field-types';
import { isWorkspaceMember } from './profile';
import { contactSearchTerm } from './search-term';

/** One statement per action; past this, narrow the filter first. */
export const MAX_BULK_CONTACTS = 50_000;

/** Longest custom field value a bulk action writes. */
export const MAX_BULK_FIELD_VALUE = 1000;

const uuid = z.string().uuid();

/** The contacts page's channel filter (Stage 5). */
export const CONTACT_CHANNEL_FILTERS = ['whatsapp', 'instagram'] as const;
export type ContactChannelFilter = (typeof CONTACT_CHANNEL_FILTERS)[number];

export const bulkScopeSchema = z.object({
  segmentId: uuid.optional(),
  listId: uuid.optional(),
  tagIds: z.array(uuid).min(1).max(50).optional(),
  search: z.string().max(200).optional(),
  /** Stage 5: the rows ticked on the page (one page, at most 100), for the Stage 5 actions. */
  contactIds: z.array(uuid).min(1).max(100).optional(),
  /** Stage 5: only contacts reachable on this channel. */
  channel: z.enum(CONTACT_CHANNEL_FILTERS).optional(),
  /** Stage 5: only contacts subscribed on Instagram (an identity and no Instagram opt-out). */
  subscribedOnly: z.boolean().optional(),
  /** Contacts redesign: only contacts owned by this member, or by no one ('none'). */
  ownerId: z.union([uuid, z.literal('none')]).optional(),
  /** Contacts redesign: WhatsApp consent; opted_in is "not opted out" (marketing allowed). */
  consent: z.enum(['opted_in', 'opted_out']).optional(),
}).strict().refine((s) => [s.segmentId, s.listId, s.tagIds, s.contactIds].filter(Boolean).length <= 1, 'Choose one view');
export type BulkScope = z.infer<typeof bulkScopeSchema>;

const pauseMinutes = z.number().int().nullable()
  .refine((m) => (PAUSE_MINUTES_CHOICES as readonly (number | null)[]).includes(m), 'Choose a pause length');

const bulkSchema = z.object({
  scope: bulkScopeSchema,
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('add_to_list'), listId: uuid }).strict(),
    z.object({ type: z.literal('remove_from_list'), listId: uuid }).strict(),
    z.object({ type: z.literal('add_tag'), tagId: uuid }).strict(),
    z.object({ type: z.literal('delete') }).strict(),
    // Stage 5 actions.
    z.object({ type: z.literal('remove_tag'), tagId: uuid }).strict(),
    z.object({ type: z.literal('unsubscribe_instagram') }).strict(),
    /** minutes: one of PAUSE_MINUTES_CHOICES; null pauses until someone resumes. */
    z.object({ type: z.literal('pause_automations'), minutes: pauseMinutes }).strict(),
    z.object({ type: z.literal('set_field'), fieldId: uuid, value: z.string().trim().min(1).max(MAX_BULK_FIELD_VALUE) }).strict(),
    /** Contacts redesign: set (null: remove) the owner; the owner must be a workspace member. */
    z.object({ type: z.literal('assign_owner'), ownerId: uuid.nullable() }).strict(),
  ]),
  /** The match count the user was shown. */
  expected: z.number().int().min(1),
}).strict();

export type BulkContactInput = z.input<typeof bulkSchema>;
export type BulkAction = z.infer<typeof bulkSchema>['action'];

/** The matching contacts changed since the page was loaded. */
export class BulkCountChangedError extends AudienceFilterError {
  constructor(readonly matched: number) {
    super('The contacts matching this view changed. Reload the page and try again.');
  }
}

/** A scope from a query string (`tagIds` comma-separated, `subscribed=1`); bulkScopeSchema validates it. */
export function scopeFromQuery(query: URLSearchParams): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  const segmentId = query.get('segmentId');
  const listId = query.get('listId');
  const tagIds = query.get('tagIds');
  const search = query.get('search');
  const channel = query.get('channel');
  if (segmentId) scope.segmentId = segmentId;
  if (listId) scope.listId = listId;
  if (tagIds) scope.tagIds = tagIds.split(',').filter(Boolean);
  if (search?.trim()) scope.search = search.slice(0, 200);
  if (channel) scope.channel = channel;
  if (query.get('subscribed') === '1') scope.subscribedOnly = true;
  const ownerId = query.get('ownerId');
  const consent = query.get('consent');
  if (ownerId) scope.ownerId = ownerId;
  if (consent) scope.consent = consent;
  return scope;
}

/** The contacts table's sort orders (Contacts redesign); 'created' newest first is the default. */
export const CONTACT_SORTS = ['created', 'name', 'city', 'owner', 'seen'] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];

/** A sort from the query string (`sort=name&dir=asc`); anything else is newest first. */
export function sortFromQuery(query: URLSearchParams): { sort: ContactSort; dir: 'asc' | 'desc' } {
  const sort = (CONTACT_SORTS as readonly string[]).includes(query.get('sort') ?? '') ? (query.get('sort') as ContactSort) : 'created';
  const dir = query.get('dir') === 'asc' ? 'asc' : query.get('dir') === 'desc' ? 'desc' : sort === 'created' || sort === 'seen' ? 'desc' : 'asc';
  return { sort, dir };
}

/** The ORDER BY of a sort (fixed SQL; empty values last either way, id as the tiebreak). */
export function sortSql(sort: ContactSort, dir: 'asc' | 'desc'): Prisma.Sql {
  const d = Prisma.raw(dir === 'asc' ? 'ASC' : 'DESC');
  switch (sort) {
    case 'name':
      return Prisma.sql`lower(NULLIF(c.name,'')) ${d} NULLS LAST, c.created_at DESC, c.id`;
    case 'city':
      return Prisma.sql`lower(NULLIF(c.city,'')) ${d} NULLS LAST, lower(c.name), c.id`;
    case 'owner':
      return Prisma.sql`lower(owner_name) ${d} NULLS LAST, lower(c.name), c.id`;
    case 'seen':
      return Prisma.sql`last_seen_at ${d} NULLS LAST, c.created_at DESC, c.id`;
    default:
      return Prisma.sql`c.created_at ${d}, c.id`;
  }
}

/**
 * The Stage 5 channel narrowing as audience conditions, ANDed with the view
 * (kept apart from it, so a segment matching any of its conditions stays one
 * OR group). Empty when the scope has neither.
 */
export function channelFilter(scope: Pick<BulkScope, 'channel' | 'subscribedOnly'>): AudienceFilter {
  const conditions: AudienceFilter['conditions'] = [];
  if (scope.channel === 'whatsapp') conditions.push({ field: 'whatsapp', op: 'has_number' });
  if (scope.channel === 'instagram') conditions.push({ field: 'instagram', op: 'has_identity' });
  if (scope.subscribedOnly) conditions.push({ field: 'instagram_subscription', op: 'subscribed' });
  return { conditions };
}

/** The view as an audience filter, the same rows the page lists. */
async function viewFilter(tx: TenantTransaction, accountId: string, scope: BulkScope): Promise<AudienceFilter> {
  if (scope.segmentId) {
    const filter = await loadSegmentFilter(tx, accountId, scope.segmentId);
    await assertFilterReferences(tx, accountId, filter);
    return filter;
  }
  if (scope.listId) {
    const list = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM contact_lists WHERE account_id=${accountId}::uuid AND id=${scope.listId}::uuid`;
    if (!list[0]) throw new AudienceNotFoundError('List not found');
    return listFilter(scope.listId);
  }
  if (scope.tagIds) return { conditions: [{ field: 'tags', op: 'has_any', tagIds: scope.tagIds }] };
  return { conditions: [] };
}

/** The WHERE over `contacts c` of a scope: the view, the channel narrowing and the search box. */
async function scopeWhere(tx: TenantTransaction, ctx: TenantContext, scope: BulkScope, maskPhones: boolean): Promise<Prisma.Sql> {
  const filter = await viewFilter(tx, ctx.accountId, scope);
  // The unfiltered page searches with ',' and brackets as wildcards (search-term.ts).
  const plain = !scope.segmentId && !scope.listId && !scope.tagIds;
  const search = scope.search ? (plain ? contactSearchTerm(scope.search) : scope.search) : undefined;
  const channel = channelFilter(scope);
  const narrowed = channel.conditions.length ? Prisma.sql`AND ${compileAudienceFilter(ctx.accountId, channel)}` : Prisma.empty;
  const picked = scope.contactIds ? Prisma.sql`AND c.id = ANY(${scope.contactIds}::uuid[])` : Prisma.empty;
  const owner = scope.ownerId === 'none' ? Prisma.sql`AND c.owner_id IS NULL`
    : scope.ownerId ? Prisma.sql`AND c.owner_id = ${scope.ownerId}::uuid` : Prisma.empty;
  const consent = scope.consent === 'opted_out' ? Prisma.sql`AND c.opted_out_at IS NOT NULL`
    : scope.consent === 'opted_in' ? Prisma.sql`AND c.opted_out_at IS NULL` : Prisma.empty;
  return Prisma.sql`${compileAudienceFilter(ctx.accountId, filter)} ${picked} ${narrowed} ${owner} ${consent} ${contactSearchSql(search, maskPhones)}`;
}

const CONTACT_COLUMNS = Prisma.sql`c.id::text, c.user_id::text, c.account_id::text, c.phone, c.name, c.email, c.company,
  c.avatar_url, c.created_at, c.updated_at, c.wa_user_id, c.wa_username, c.opted_out_at, c.opt_out_source, c.blocked_at,
  c.opted_in_at, c.instagram_opted_out_at, c.city, c.owner_id::text`;

/**
 * One page of the contacts a bulk action on `scope` would reach, with the
 * total: the contacts page lists through this, so the count it shows is the
 * count the action checks. Newest first unless `page.sort` says otherwise.
 * Each row also carries the owner's name, the last message time of the
 * conversations the member may see, and the first Instagram username
 * (masked like a number for a masked member).
 */
export async function scopeContacts(ctx: TenantContext, rawScope: unknown,
  page: { offset: number; limit: number; sort?: ContactSort; dir?: 'asc' | 'desc' }):
  Promise<{ contacts: Record<string, unknown>[]; total: number }> {
  const parsed = bulkScopeSchema.safeParse(rawScope);
  if (!parsed.success) throw new AudienceFilterError(parsed.error.issues[0]?.message ?? 'Invalid request');
  const sort = page.sort ?? 'created';
  const dir = page.dir ?? (sort === 'created' || sort === 'seen' ? 'desc' : 'asc');
  return withTenant(ctx, async (tx) => {
    const maskPhones = await loadPhoneMask(tx, ctx);
    const where = await scopeWhere(tx, ctx, parsed.data, maskPhones);
    const rows = await tx.$queryRaw<(Record<string, unknown> & { total_count: number })[]>(Prisma.sql`
      SELECT * FROM (
        SELECT ${CONTACT_COLUMNS}, count(*) OVER()::int AS total_count,
          (SELECT p.full_name FROM profiles p WHERE p.account_id=c.account_id AND p.user_id=c.owner_id LIMIT 1) AS owner_name,
          (SELECT max(v.last_message_at) FROM conversations v WHERE v.account_id=c.account_id AND v.contact_id=c.id
            AND ${Prisma.raw(conversationVisibleSql('v'))}) AS last_seen_at,
          (SELECT i.username FROM contact_channel_identities i WHERE i.account_id=c.account_id AND i.contact_id=c.id
            AND i.channel='instagram' ORDER BY i.created_at LIMIT 1) AS instagram_username
        FROM contacts c WHERE ${where}
      ) c
      ORDER BY ${sortSql(sort, dir)} LIMIT ${page.limit} OFFSET ${page.offset}`);
    const total = rows[0]?.total_count ?? 0;
    return {
      contacts: rows.map((row) => {
        const contact: Record<string, unknown> = { ...row };
        delete contact.total_count;
        if (maskPhones && typeof contact.instagram_username === 'string') contact.instagram_username = maskContactIdentifier(contact.instagram_username);
        return maskContactRow(contact, maskPhones);
      }),
      total,
    };
  });
}

export type InstagramContactStatus = 'subscribed' | 'unsubscribed' | 'none';

/** Subscribed: an Instagram identity and no Instagram opt-out; unsubscribed: opted out; none: never on Instagram. */
export function instagramContactStatus(hasIdentity: boolean, optedOut: boolean): InstagramContactStatus {
  if (optedOut) return 'unsubscribed';
  return hasIdentity ? 'subscribed' : 'none';
}

/** Most contacts one status request covers (four pages of the contacts table). */
export const MAX_STATUS_IDS = 100;

/** The contacts page's Instagram status column for contacts of the caller's workspace (others are left out). */
export async function contactChannelStatus(ctx: TenantContext, ids: string[]): Promise<Record<string, InstagramContactStatus>> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => uuid.safeParse(id).success).slice(0, MAX_STATUS_IDS);
  if (!wanted.length) return {};
  const rows = await withTenant(ctx, (tx) => tx.$queryRaw<{ id: string; has_identity: boolean; opted_out: boolean }[]>(Prisma.sql`
    SELECT c.id::text AS id, c.instagram_opted_out_at IS NOT NULL AS opted_out,
      EXISTS (SELECT 1 FROM contact_channel_identities i
        WHERE i.account_id=c.account_id AND i.contact_id=c.id AND i.channel='instagram') AS has_identity
    FROM contacts c WHERE c.account_id=${ctx.accountId}::uuid AND c.id = ANY(${wanted}::uuid[])`));
  return Object.fromEntries(rows.map((row) => [row.id, instagramContactStatus(row.has_identity, row.opted_out)]));
}

export async function bulkContactAction(ctx: TenantContext, input: unknown): Promise<{ matched: number; changed: number }> {
  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) throw new AudienceFilterError(parsed.error.issues[0]?.message ?? 'Invalid request');
  const { scope, action, expected } = parsed.data;

  return withTenant(ctx, async (tx) => {
    const where = await scopeWhere(tx, ctx, scope, await loadPhoneMask(tx, ctx));

    // Lock the matching rows so the count and the action see the same set.
    const ids = (await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT c.id::text FROM contacts c WHERE ${where} LIMIT ${MAX_BULK_CONTACTS + 1} FOR UPDATE OF c`)).map((row) => row.id);
    if (ids.length > MAX_BULK_CONTACTS)
      throw new AudienceFilterError(`Bulk actions reach at most ${MAX_BULK_CONTACTS.toLocaleString('en')} contacts. Narrow the filter first.`);
    if (ids.length !== expected) throw new BulkCountChangedError(ids.length);
    const matching = Prisma.sql`SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)`;

    let changed: number;
    switch (action.type) {
      case 'add_to_list':
      case 'remove_from_list': {
        const list = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM contact_lists WHERE account_id=${ctx.accountId}::uuid AND id=${action.listId}::uuid FOR UPDATE`;
        if (!list[0]) throw new AudienceNotFoundError('List not found');
        changed = action.type === 'add_to_list'
          ? await tx.$executeRaw(Prisma.sql`
              INSERT INTO contact_list_members(account_id,list_id,contact_id)
              SELECT ${ctx.accountId}::uuid, ${action.listId}::uuid, id FROM (${matching}) m(id)
              ON CONFLICT DO NOTHING`)
          : await tx.$executeRaw(Prisma.sql`
              DELETE FROM contact_list_members WHERE account_id=${ctx.accountId}::uuid AND list_id=${action.listId}::uuid
                AND contact_id IN (${matching})`);
        await tx.$executeRaw`UPDATE contact_lists SET updated_at=now() WHERE id=${action.listId}::uuid`;
        break;
      }
      case 'add_tag': {
        const tag = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tags WHERE account_id=${ctx.accountId}::uuid AND id=${action.tagId}::uuid`;
        if (!tag[0]) throw new AudienceNotFoundError('Tag not found');
        // Like CSV import, a bulk tag does not run tag_added automations: one
        // click must not start an automation for thousands of contacts.
        changed = await tx.$executeRaw(Prisma.sql`
          INSERT INTO contact_tags(account_id,contact_id,tag_id)
          SELECT ${ctx.accountId}::uuid, id, ${action.tagId}::uuid FROM (${matching}) m(id)
          ON CONFLICT (contact_id, tag_id) DO NOTHING`);
        break;
      }
      case 'delete':
        changed = await tx.$executeRaw(Prisma.sql`
          DELETE FROM contacts WHERE account_id=${ctx.accountId}::uuid AND id IN (${matching})`);
        break;
      case 'remove_tag': {
        const tag = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tags WHERE account_id=${ctx.accountId}::uuid AND id=${action.tagId}::uuid`;
        if (!tag[0]) throw new AudienceNotFoundError('Tag not found');
        changed = await tx.$executeRaw(Prisma.sql`
          DELETE FROM contact_tags WHERE account_id=${ctx.accountId}::uuid AND tag_id=${action.tagId}::uuid
            AND contact_id IN (${matching})`);
        break;
      }
      case 'unsubscribe_instagram':
        // Instagram only, like an Instagram STOP (channel-consent.ts): the contact-wide
        // opted_out_at (WhatsApp) is untouched. Already unsubscribed contacts keep their time.
        changed = await tx.$executeRaw(Prisma.sql`
          UPDATE contacts SET instagram_opted_out_at=now(), updated_at=now()
          WHERE account_id=${ctx.accountId}::uuid AND instagram_opted_out_at IS NULL AND id IN (${matching})`);
        break;
      case 'pause_automations': {
        // The contacts' conversations the member may see (agent visibility), with who
        // paused and until when (the columns automation-pause.ts and bot-pause.ts read).
        // Without the explicit-pause mark, conversations_pause_reset clears the until and author.
        await markExplicitPause(tx);
        const until = action.minutes === null ? Prisma.sql`NULL::timestamptz` : Prisma.sql`now() + make_interval(mins => ${action.minutes}::int)`;
        changed = await tx.$executeRaw(Prisma.sql`
          UPDATE conversations v SET bot_paused=true, bot_paused_until=${until}, bot_paused_by=${ctx.userId || null}::uuid
          WHERE v.account_id=${ctx.accountId}::uuid AND v.contact_id IN (${matching})
            AND ${Prisma.raw(conversationVisibleSql('v'))}`);
        break;
      }
      case 'set_field': {
        const field = await tx.$queryRaw<{ id: string; field_type: string; field_options: unknown }[]>`
          SELECT id, field_type, field_options FROM custom_fields WHERE account_id=${ctx.accountId}::uuid AND id=${action.fieldId}::uuid`;
        if (!field[0]) throw new AudienceNotFoundError('Custom field not found');
        // A number, date or choice field only takes a value of its type (custom-field-types.ts).
        const typed = normalizeFieldValue(field[0], action.value);
        if (!typed.ok || !typed.value) throw new AudienceFilterError(`This value does not fit the field (${typed.ok ? 'empty' : typed.problem.replace(/_/g, ' ')})`);
        changed = await tx.$executeRaw(Prisma.sql`
          INSERT INTO contact_custom_values(account_id,contact_id,custom_field_id,value)
          SELECT ${ctx.accountId}::uuid, id, ${action.fieldId}::uuid, ${typed.value} FROM (${matching}) m(id)
          ON CONFLICT (contact_id, custom_field_id) DO UPDATE SET value=EXCLUDED.value`);
        break;
      }
      case 'assign_owner': {
        if (action.ownerId && !(await isWorkspaceMember(tx, ctx.accountId, action.ownerId)))
          throw new AudienceFilterError('The owner must be a member of this workspace');
        const updated = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          UPDATE contacts SET owner_id=${action.ownerId}::uuid, updated_at=now()
          WHERE account_id=${ctx.accountId}::uuid AND id IN (${matching}) AND owner_id IS DISTINCT FROM ${action.ownerId}::uuid
          RETURNING id::text`);
        changed = updated.length;
        // One timeline row per contact that changed (ids only).
        if (changed)
          await tx.$executeRaw`INSERT INTO contact_activity(account_id, contact_id, actor_id, kind, detail)
            SELECT ${ctx.accountId}::uuid, value::uuid, ${ctx.userId || null}::uuid, 'owner_changed', ${JSON.stringify({ owner_id: action.ownerId })}::jsonb
            FROM jsonb_array_elements_text(${JSON.stringify(updated.map((r) => r.id))}::jsonb)`;
        break;
      }
    }
    return { matched: ids.length, changed };
  });
}
