// ============================================================
// Static contact lists: hand-picked contacts, unlike segments which
// are live filters. Runs in the caller's tenant transaction on the app
// role, so RLS decides read (any member) and write (agent and above).
// ============================================================

import { z } from 'zod';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { AudienceFilterError, type AudienceFilter } from './filter';
import { pageContacts, type ContactPage } from './segments';
import { loadPhoneMask } from '@/lib/inbox/masking-apply';
import { requireRoomFor } from '@/lib/billing/entitlements';

export interface ContactList {
  id: string;
  name: string;
  member_count: number;
  created_at: string;
}

export const MAX_LIST_CHANGE = 1000;
const DUPLICATE = 'A list with this name already exists';
const nameSchema = z.string().trim().min(1, 'Enter a list name').max(100, 'List names are at most 100 characters');
const changeSchema = z.object({
  add: z.array(z.string().uuid()).max(MAX_LIST_CHANGE).optional(),
  remove: z.array(z.string().uuid()).max(MAX_LIST_CHANGE).optional(),
}).strict().refine((c) => c.add?.length || c.remove?.length, 'Choose contacts to add or remove');

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AudienceFilterError(parsed.error.issues[0]?.message ?? 'Invalid request');
  return parsed.data;
}

/** The filter that selects one list's members (lists reuse the audience engine). */
export const listFilter = (listId: string): AudienceFilter => ({ conditions: [{ field: 'list', op: 'in_any', listIds: [listId] }] });

export function listLists(ctx: TenantContext): Promise<ContactList[]> {
  return withTenant(ctx, (tx) => tx.$queryRaw<ContactList[]>`
    SELECT l.id::text, l.name, l.created_at,
      (SELECT count(*)::int FROM contact_list_members m WHERE m.account_id=l.account_id AND m.list_id=l.id) AS member_count
    FROM contact_lists l WHERE l.account_id=${ctx.accountId}::uuid ORDER BY l.name`);
}

export async function createList(ctx: TenantContext, input: unknown): Promise<ContactList> {
  const name = parse(nameSchema, (input as { name?: unknown } | null)?.name);
  return withTenant(ctx, async (tx) => {
    await requireRoomFor(tx, ctx.accountId, 'lists', async () =>
      (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM contact_lists WHERE account_id=${ctx.accountId}::uuid AND archived_at IS NULL`)[0].n);
    const rows = await tx.$queryRaw<ContactList[]>`
      INSERT INTO contact_lists(account_id,user_id,name) VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,${name})
      ON CONFLICT (account_id,name) DO NOTHING RETURNING id::text, name, created_at, 0 AS member_count`;
    if (!rows[0]) throw new AudienceFilterError(DUPLICATE);
    return rows[0];
  });
}

/** Returns false when the id is not a list of this account. */
export async function deleteList(ctx: TenantContext, id: string): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      DELETE FROM contact_lists WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid RETURNING id::text`;
    return rows.length > 0;
  });
}

/**
 * Add and/or remove contacts. Only contacts of this account are added;
 * duplicates are ignored. Returns null when the list is not this account's.
 */
export async function changeListMembers(
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ added: number; removed: number } | null> {
  const change = parse(changeSchema, input);
  return withTenant(ctx, async (tx) => {
    const list = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM contact_lists WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
    if (!list[0]) return null;
    const added = change.add?.length
      ? await tx.$executeRaw`
          INSERT INTO contact_list_members(account_id,list_id,contact_id)
          SELECT c.account_id, ${id}::uuid, c.id FROM contacts c
          WHERE c.account_id=${ctx.accountId}::uuid
            AND c.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(change.add)}::jsonb))
          ON CONFLICT DO NOTHING`
      : 0;
    const removed = change.remove?.length
      ? await tx.$executeRaw`
          DELETE FROM contact_list_members WHERE account_id=${ctx.accountId}::uuid AND list_id=${id}::uuid
            AND contact_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(change.remove)}::jsonb))`
      : 0;
    await tx.$executeRaw`UPDATE contact_lists SET updated_at=now() WHERE id=${id}::uuid`;
    return { added, removed };
  });
}

/** One page of a list's contacts; null when the list is not this account's. */
export async function listContacts(ctx: TenantContext, id: string, page: ContactPage) {
  return withTenant(ctx, async (tx) => {
    const list = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM contact_lists WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    return list[0] ? pageContacts(tx, ctx.accountId, listFilter(id), { ...page, maskPhones: await loadPhoneMask(tx, ctx) }) : null;
  });
}
