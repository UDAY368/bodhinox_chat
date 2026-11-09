// ============================================================
// Bulk contact actions on every contact matching the contacts page's
// current view (a segment, a list, a tag filter or none, plus the search
// box), not only the 25 rows on screen. The browser sends the view and the
// count it showed; the action runs only if the match count is still that
// number, so nobody deletes or tags more than they were shown. Runs in the
// caller's tenant transaction on the app role (RLS: agent and above).
// ============================================================

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { AudienceFilterError, AudienceNotFoundError, assertFilterReferences, compileAudienceFilter, type AudienceFilter } from '@/lib/audience/filter';
import { listFilter } from '@/lib/audience/lists';
import { contactSearchSql, loadSegmentFilter } from '@/lib/audience/segments';
import { loadPhoneMask } from '@/lib/inbox/masking-apply';
import { contactSearchTerm } from './search-term';

/** One statement per action; past this, narrow the filter first. */
export const MAX_BULK_CONTACTS = 50_000;

const uuid = z.string().uuid();

const bulkSchema = z.object({
  scope: z.object({
    segmentId: uuid.optional(),
    listId: uuid.optional(),
    tagIds: z.array(uuid).min(1).max(50).optional(),
    search: z.string().max(200).optional(),
  }).strict().refine((s) => [s.segmentId, s.listId, s.tagIds].filter(Boolean).length <= 1, 'Choose one view'),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('add_to_list'), listId: uuid }).strict(),
    z.object({ type: z.literal('remove_from_list'), listId: uuid }).strict(),
    z.object({ type: z.literal('add_tag'), tagId: uuid }).strict(),
    z.object({ type: z.literal('delete') }).strict(),
  ]),
  /** The match count the user was shown. */
  expected: z.number().int().min(1),
}).strict();

export type BulkContactInput = z.input<typeof bulkSchema>;

/** The matching contacts changed since the page was loaded. */
export class BulkCountChangedError extends AudienceFilterError {
  constructor(readonly matched: number) {
    super('The contacts matching this view changed. Reload the page and try again.');
  }
}

/** The view as an audience filter, the same rows the page lists. */
async function viewFilter(tx: TenantTransaction, accountId: string, scope: z.infer<typeof bulkSchema>['scope']): Promise<AudienceFilter> {
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

export async function bulkContactAction(ctx: TenantContext, input: unknown): Promise<{ matched: number; changed: number }> {
  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) throw new AudienceFilterError(parsed.error.issues[0]?.message ?? 'Invalid request');
  const { scope, action, expected } = parsed.data;

  return withTenant(ctx, async (tx) => {
    const filter = await viewFilter(tx, ctx.accountId, scope);
    // The unfiltered page searches with ',' and brackets as wildcards (search-term.ts).
    const plain = !scope.segmentId && !scope.listId && !scope.tagIds;
    const search = scope.search ? (plain ? contactSearchTerm(scope.search) : scope.search) : undefined;
    const where = Prisma.sql`${compileAudienceFilter(ctx.accountId, filter)} ${contactSearchSql(search, await loadPhoneMask(tx, ctx))}`;

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
    }
    return { matched: ids.length, changed };
  });
}
