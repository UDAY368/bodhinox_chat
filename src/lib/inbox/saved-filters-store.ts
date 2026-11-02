// Per-member inbox preferences: saved views and favourite quick replies.
// Every query runs inside withTenant as the live member; the own_rows RLS
// policies scope both tables to (account_id, user_id) and the explicit
// user_id filters below repeat that so a policy change cannot widen reads.

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import {
  isUuid,
  MAX_SAVED_FILTERS,
  parseInboxFilters,
  parseSavedFilterName,
  type InboxFilters,
  type SavedFilter,
} from './saved-filters';

const t = getT('Api');
const MAX_POSITION = 10_000;

/** Per-member write budget for saved views and favourites. */
export const PREFERENCE_WRITE_LIMIT = { limit: 60, windowMs: 60_000 };

/** Input errors carry a safe message and an HTTP status. */
export class InboxPreferenceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'InboxPreferenceError';
  }
}

/** 400/404/409 with the safe message; anything else goes through toErrorResponse. */
export function inboxPreferenceErrorResponse(error: unknown): NextResponse {
  if (error instanceof InboxPreferenceError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  return toErrorResponse(error);
}

type Member = TenantContext & { userId: string };

function member(ctx: TenantContext): Member {
  if (!ctx.userId) throw new Error('A member identity is required');
  return ctx as Member;
}

type Row = { id: string; name: string; filters: unknown; position: number; created_at: Date };

const toDto = (row: Row): SavedFilter => ({
  id: row.id,
  name: row.name,
  filters: parseInboxFilters(row.filters),
  position: row.position,
  created_at: row.created_at.toISOString(),
});

const select = { id: true, name: true, filters: true, position: true, created_at: true } as const;

export async function listSavedFilters(ctx: TenantContext): Promise<SavedFilter[]> {
  const me = member(ctx);
  const rows = await withTenant(me, (tx) => tx.saved_filters.findMany({
    where: { account_id: me.accountId, user_id: me.userId },
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
    select,
  }));
  return rows.map(toDto);
}

/** Validates a create body: `{ name, filters }`. */
export function parseSavedFilterCreate(body: unknown): { name: string; filters: InboxFilters } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = parseSavedFilterName(input.name);
  if (!name) throw new InboxPreferenceError(t('savedFilters.nameInvalid'), 400);
  if (!input.filters || typeof input.filters !== 'object' || Array.isArray(input.filters))
    throw new InboxPreferenceError(t('savedFilters.filtersInvalid'), 400);
  return { name, filters: parseInboxFilters(input.filters) };
}

/** Validates a patch body: any of `{ name, filters, position }`. */
export function parseSavedFilterPatch(body: unknown): { name?: string; filters?: InboxFilters; position?: number } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const patch: { name?: string; filters?: InboxFilters; position?: number } = {};
  if ('name' in input) {
    const name = parseSavedFilterName(input.name);
    if (!name) throw new InboxPreferenceError(t('savedFilters.nameInvalid'), 400);
    patch.name = name;
  }
  if ('filters' in input) {
    if (!input.filters || typeof input.filters !== 'object' || Array.isArray(input.filters))
      throw new InboxPreferenceError(t('savedFilters.filtersInvalid'), 400);
    patch.filters = parseInboxFilters(input.filters);
  }
  if ('position' in input) {
    const position = input.position;
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > MAX_POSITION)
      throw new InboxPreferenceError(t('savedFilters.positionInvalid'), 400);
    patch.position = position;
  }
  if (Object.keys(patch).length === 0) throw new InboxPreferenceError(t('savedFilters.nothingToUpdate'), 400);
  return patch;
}

export async function createSavedFilter(
  ctx: TenantContext,
  input: { name: string; filters: InboxFilters }
): Promise<SavedFilter> {
  const me = member(ctx);
  return withTenant(me, async (tx) => {
    // Serialise this member's creates so the cap holds under concurrent saves.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('saved_filters'), hashtext(${me.userId}))`;
    const where = { account_id: me.accountId, user_id: me.userId };
    const count = await tx.saved_filters.count({ where });
    if (count >= MAX_SAVED_FILTERS)
      throw new InboxPreferenceError(t('savedFilters.limitReached', { max: MAX_SAVED_FILTERS }), 409);
    const last = await tx.saved_filters.aggregate({ where, _max: { position: true } });
    const row = await tx.saved_filters.create({
      data: {
        account_id: me.accountId,
        user_id: me.userId,
        name: input.name,
        filters: { ...input.filters },
        position: Math.min((last._max.position ?? -1) + 1, MAX_POSITION),
      },
      select,
    });
    return toDto(row);
  });
}

export async function updateSavedFilter(
  ctx: TenantContext,
  id: string,
  patch: { name?: string; filters?: InboxFilters; position?: number }
): Promise<SavedFilter> {
  const me = member(ctx);
  if (!isUuid(id)) throw new InboxPreferenceError(t('savedFilters.notFound'), 404);
  return withTenant(me, async (tx) => {
    const where = { id, account_id: me.accountId, user_id: me.userId };
    const data = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.filters !== undefined ? { filters: { ...patch.filters } } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    };
    const { count } = await tx.saved_filters.updateMany({ where, data });
    if (count === 0) throw new InboxPreferenceError(t('savedFilters.notFound'), 404);
    return toDto(await tx.saved_filters.findFirstOrThrow({ where, select }));
  });
}

export async function deleteSavedFilter(ctx: TenantContext, id: string): Promise<void> {
  const me = member(ctx);
  if (!isUuid(id)) throw new InboxPreferenceError(t('savedFilters.notFound'), 404);
  const { count } = await withTenant(me, (tx) => tx.saved_filters.deleteMany({
    where: { id, account_id: me.accountId, user_id: me.userId },
  }));
  if (count === 0) throw new InboxPreferenceError(t('savedFilters.notFound'), 404);
}

/** The member's favourite quick reply ids, most recently starred first. */
export async function listQuickReplyFavourites(ctx: TenantContext): Promise<string[]> {
  const me = member(ctx);
  const rows = await withTenant(me, (tx) => tx.quick_reply_favourites.findMany({
    where: { account_id: me.accountId, user_id: me.userId },
    orderBy: { created_at: 'desc' },
    select: { quick_reply_id: true },
  }));
  return rows.map((row) => row.quick_reply_id);
}

/** Validates `{ quick_reply_id, favourite }`. */
export function parseFavouriteBody(body: unknown): { quickReplyId: string; favourite: boolean } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!isUuid(input.quick_reply_id) || typeof input.favourite !== 'boolean')
    throw new InboxPreferenceError(t('savedFilters.favouriteInvalid'), 400);
  return { quickReplyId: input.quick_reply_id.toLowerCase(), favourite: input.favourite };
}

/** Idempotently stars or unstars a workspace quick reply for this member. */
export async function setQuickReplyFavourite(
  ctx: TenantContext,
  quickReplyId: string,
  favourite: boolean
): Promise<void> {
  const me = member(ctx);
  await withTenant(me, async (tx) => {
    const where = { account_id: me.accountId, user_id: me.userId, quick_reply_id: quickReplyId };
    if (!favourite) {
      await tx.quick_reply_favourites.deleteMany({ where });
      return;
    }
    const exists = await tx.quick_replies.findFirst({
      where: { id: quickReplyId, account_id: me.accountId },
      select: { id: true },
    });
    if (!exists) throw new InboxPreferenceError(t('savedFilters.quickReplyNotFound'), 404);
    await tx.quick_reply_favourites.createMany({ data: [where], skipDuplicates: true });
  });
}
