// ============================================================
// Saved segments: named audience filters resolved live against
// contacts. Runs in the caller's tenant transaction on the app role,
// so RLS decides read (any member) and write (agent and above).
// ============================================================

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import {
  AudienceFilterError,
  assertFilterReferences,
  compileAudienceFilter,
  parseAudienceFilter,
  type AudienceFilter,
} from './filter';
import { requireRoomFor } from '@/lib/billing/entitlements';

export interface Segment {
  id: string;
  name: string;
  filter: AudienceFilter;
  created_at: string;
  updated_at: string;
}

const nameSchema = z.string().trim().min(1, 'Enter a segment name').max(100, 'Segment names are at most 100 characters');
function parseName(input: unknown): string {
  const parsed = nameSchema.safeParse(input);
  if (!parsed.success) throw new AudienceFilterError(parsed.error.issues[0].message);
  return parsed.data;
}
function body(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AudienceFilterError('Request body must be a JSON object');
  return input as Record<string, unknown>;
}

const SEGMENT_COLUMNS = Prisma.sql`id::text, name, filter, created_at, updated_at`;
const DUPLICATE = 'A segment with this name already exists';

export function listSegments(ctx: TenantContext): Promise<Segment[]> {
  return withTenant(ctx, (tx) =>
    tx.$queryRaw<Segment[]>`SELECT ${SEGMENT_COLUMNS} FROM segments WHERE account_id=${ctx.accountId}::uuid ORDER BY name`,
  );
}

export async function createSegment(ctx: TenantContext, input: unknown): Promise<Segment> {
  const data = body(input);
  const name = parseName(data.name);
  const filter = parseAudienceFilter(data.filter);
  return withTenant(ctx, async (tx) => {
    await assertFilterReferences(tx, ctx.accountId, filter);
    await requireRoomFor(tx, ctx.accountId, 'segments', async () =>
      (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM segments WHERE account_id=${ctx.accountId}::uuid`)[0].n);
    const rows = await tx.$queryRaw<Segment[]>`
      INSERT INTO segments(account_id,user_id,name,filter)
      VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,${name},${JSON.stringify(filter)}::jsonb)
      ON CONFLICT (account_id,name) DO NOTHING RETURNING ${SEGMENT_COLUMNS}`;
    if (!rows[0]) throw new AudienceFilterError(DUPLICATE);
    return rows[0];
  });
}

/** Returns null when the id is not a segment of this account. */
export async function updateSegment(ctx: TenantContext, id: string, input: unknown): Promise<Segment | null> {
  const data = body(input);
  const name = 'name' in data ? parseName(data.name) : null;
  const filter = 'filter' in data ? parseAudienceFilter(data.filter) : null;
  if (!name && !filter) throw new AudienceFilterError('No updatable fields provided');
  return withTenant(ctx, async (tx) => {
    if (filter) await assertFilterReferences(tx, ctx.accountId, filter);
    try {
      const rows = await tx.$queryRaw<Segment[]>`
        UPDATE segments SET name=COALESCE(${name},name),
          filter=COALESCE(${filter ? JSON.stringify(filter) : null}::jsonb,filter)
        WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid RETURNING ${SEGMENT_COLUMNS}`;
      return rows[0] ?? null;
    } catch (error) {
      if (String((error as { meta?: { code?: string } })?.meta?.code ?? error).includes('23505')) throw new AudienceFilterError(DUPLICATE);
      throw error;
    }
  });
}

/** Returns false when the id is not a segment of this account. */
export async function deleteSegment(ctx: TenantContext, id: string): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      DELETE FROM segments WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid RETURNING id::text`;
    return rows.length > 0;
  });
}

/** The stored filter of one segment, locked for the caller's transaction. */
export async function loadSegmentFilter(tx: TenantTransaction, accountId: string, id: string): Promise<AudienceFilter> {
  const rows = await tx.$queryRaw<{ filter: unknown }[]>`
    SELECT filter FROM segments WHERE account_id=${accountId}::uuid AND id=${id}::uuid FOR SHARE`;
  if (!rows[0]) throw new AudienceFilterError('Segment is unavailable in this workspace');
  return parseAudienceFilter(rows[0].filter);
}

/**
 * How many contacts match a filter (or a saved segment's filter), and how
 * many of them may receive marketing (not opted out, not blocked).
 */
export async function previewAudience(
  ctx: TenantContext,
  source: { filter: unknown } | { segmentId: string },
): Promise<{ total: number; sendable: number }> {
  const filter = 'filter' in source ? parseAudienceFilter(source.filter) : null;
  return withTenant(ctx, async (tx) => {
    const resolved = filter ?? (await loadSegmentFilter(tx, ctx.accountId, (source as { segmentId: string }).segmentId));
    // A saved segment's tags, lists or campaigns may have been deleted since it was saved.
    await assertFilterReferences(tx, ctx.accountId, resolved);
    const [row] = await tx.$queryRaw<{ total: number; sendable: number }[]>(Prisma.sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE c.opted_out_at IS NULL AND c.blocked_at IS NULL)::int AS sendable
      FROM contacts c WHERE ${compileAudienceFilter(ctx.accountId, resolved)}`);
    return row;
  });
}

const CONTACT_COLUMNS = Prisma.sql`c.id::text, c.user_id::text, c.account_id::text, c.phone, c.name, c.email, c.company,
  c.avatar_url, c.created_at, c.updated_at, c.wa_user_id, c.wa_username, c.opted_out_at, c.opt_out_source, c.blocked_at`;

export interface ContactPage { offset: number; limit: number; search?: string }

/** One page (newest first) of the contacts matching a filter, with the total match count. */
export async function pageContacts(
  tx: TenantTransaction,
  accountId: string,
  filter: AudienceFilter,
  page: ContactPage,
): Promise<{ contacts: Record<string, unknown>[]; total: number }> {
  const term = page.search?.trim();
  const search = term
    ? Prisma.sql`AND (c.name ILIKE ${`%${term}%`} OR c.phone ILIKE ${`%${term}%`} OR c.email ILIKE ${`%${term}%`})`
    : Prisma.empty;
  const rows = await tx.$queryRaw<(Record<string, unknown> & { total_count: number })[]>(Prisma.sql`
    SELECT ${CONTACT_COLUMNS}, count(*) OVER()::int AS total_count
    FROM contacts c WHERE ${compileAudienceFilter(accountId, filter)} ${search}
    ORDER BY c.created_at DESC, c.id LIMIT ${page.limit} OFFSET ${page.offset}`);
  return { contacts: rows, total: rows[0]?.total_count ?? 0 };
}

/** One page of a segment's contacts. */
export async function segmentContacts(ctx: TenantContext, id: string, page: ContactPage) {
  return withTenant(ctx, async (tx) => pageContacts(tx, ctx.accountId, await loadSegmentFilter(tx, ctx.accountId, id), page));
}
