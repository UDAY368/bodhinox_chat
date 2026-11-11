// Conversion event types (Stage 5, 5F): Settings › Conversion events.
// Admins name, rename, archive and restore types; every member may list them
// (the flow builder's "Log conversion" action picks one). A type is archived,
// never deleted, so the log keeps its name. Runs as the app role inside
// withTenant: RLS limits writes to admins of the workspace (app_write_allowed).
import { NextResponse } from 'next/server';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';

export const CONVERSION_EVENT_TYPE_LIMIT = 50;
export const CONVERSION_EVENT_NAME_MAX = 60;

export interface ConversionEventType {
  id: string;
  name: string;
  archived: boolean;
  created_at: string;
  /** Logged in the last 30 days. */
  recent_count: number;
}

export type ConversionEventErrorCode = 'invalid_name' | 'name_taken' | 'limit_reached' | 'not_found';

export class ConversionEventError extends Error {
  constructor(public readonly code: ConversionEventErrorCode) {
    super(code);
    this.name = 'ConversionEventError';
  }
}

const ERROR_STATUS: Record<ConversionEventErrorCode, number> = { invalid_name: 422, name_taken: 409, limit_reached: 422, not_found: 404 };
const ERROR_KEY: Record<ConversionEventErrorCode, string> = {
  invalid_name: 'nameInvalid', name_taken: 'nameTaken', limit_reached: 'limitReached', not_found: 'notFound',
};

/** The JSON error for a ConversionEventError (code + translated message), or null for any other error. */
export function conversionEventErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof ConversionEventError)) return null;
  const t = getT('Settings.conversionEvents');
  return NextResponse.json({ error: t(ERROR_KEY[error.code]), code: error.code },
    { status: ERROR_STATUS[error.code], headers: { 'Cache-Control': 'no-store' } });
}

/** A trimmed name of 1–60 characters, or null. */
export function normaliseEventName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= CONVERSION_EVENT_NAME_MAX ? name : null;
}

const isUniqueViolation = (error: unknown) =>
  !!error && typeof error === 'object' && /unique|duplicate|23505/i.test(String((error as { message?: unknown }).message ?? '') + String((error as { code?: unknown }).code ?? ''));

export async function listConversionEventTypes(context: TenantContext): Promise<ConversionEventType[]> {
  return withTenant(context, (tx) => tx.$queryRaw<ConversionEventType[]>`
    SELECT t.id::text, t.name, (t.archived_at IS NOT NULL) AS archived, t.created_at::text AS created_at,
      (SELECT count(*)::int FROM conversion_event_log l WHERE l.account_id=t.account_id AND l.event_type_id=t.id
        AND l.occurred_at >= now() - interval '30 days') AS recent_count
    FROM conversion_event_types t WHERE t.account_id=${context.accountId}::uuid
    ORDER BY (t.archived_at IS NOT NULL), lower(t.name)`);
}

export async function createConversionEventType(context: TenantContext, rawName: unknown): Promise<ConversionEventType> {
  const name = normaliseEventName(rawName);
  if (!name) throw new ConversionEventError('invalid_name');
  try {
    return await withTenant(context, async (tx) => {
      const [{ count }] = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM conversion_event_types
        WHERE account_id=${context.accountId}::uuid AND archived_at IS NULL`;
      if (count >= CONVERSION_EVENT_TYPE_LIMIT) throw new ConversionEventError('limit_reached');
      const [row] = await tx.$queryRaw<ConversionEventType[]>`INSERT INTO conversion_event_types(account_id,name)
        VALUES(${context.accountId}::uuid,${name})
        RETURNING id::text, name, false AS archived, created_at::text AS created_at, 0 AS recent_count`;
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConversionEventError('name_taken');
    throw error;
  }
}

/** Renames and/or archives (true) or restores (false) a type. */
export async function updateConversionEventType(context: TenantContext, id: string,
  patch: { name?: unknown; archived?: unknown }): Promise<void> {
  const name = patch.name === undefined ? undefined : normaliseEventName(patch.name);
  if (name === null) throw new ConversionEventError('invalid_name');
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw new ConversionEventError('invalid_name');
  try {
    await withTenant(context, async (tx) => {
      const existing = await tx.$queryRaw<{ archived: boolean }[]>`SELECT (archived_at IS NOT NULL) AS archived
        FROM conversion_event_types WHERE account_id=${context.accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
      if (!existing[0]) throw new ConversionEventError('not_found');
      if (patch.archived === false && existing[0].archived) {
        const [{ count }] = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM conversion_event_types
          WHERE account_id=${context.accountId}::uuid AND archived_at IS NULL`;
        if (count >= CONVERSION_EVENT_TYPE_LIMIT) throw new ConversionEventError('limit_reached');
      }
      if (name !== undefined)
        await tx.$executeRaw`UPDATE conversion_event_types SET name=${name} WHERE account_id=${context.accountId}::uuid AND id=${id}::uuid`;
      if (patch.archived === true)
        await tx.$executeRaw`UPDATE conversion_event_types SET archived_at=COALESCE(archived_at, now())
          WHERE account_id=${context.accountId}::uuid AND id=${id}::uuid`;
      if (patch.archived === false)
        await tx.$executeRaw`UPDATE conversion_event_types SET archived_at=NULL WHERE account_id=${context.accountId}::uuid AND id=${id}::uuid`;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConversionEventError('name_taken');
    throw error;
  }
}
