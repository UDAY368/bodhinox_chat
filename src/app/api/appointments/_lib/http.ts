/**
 * Shared plumbing for the staff appointment APIs (/api/appointments/**).
 *
 * Every handler: a live session (JWT + current membership + live session row),
 * Origin + CSRF proof on mutations (also enforced by the proxy), a minimum
 * role, the feature permission where it applies, and a withTenant
 * transaction that first checks the 'appointments' plan feature. Errors are
 * code-only; nothing echoes customer content.
 */
import { NextResponse } from 'next/server';
import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { requirePermission, type FeaturePermission } from '@/lib/auth/permissions';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { AppointmentFieldError } from '@/lib/appointments/config';
import { AppointmentError, isAppointmentError } from '@/lib/appointments/types';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const noStore = { 'Cache-Control': 'private, no-store' };
const t = getT('Appointments.errors');

export interface StaffCaller {
  tenant: TenantContext & { userId: string; role: AccountRole };
  accountId: string;
  userId: string;
  role: AccountRole;
}

export interface StaffOptions {
  min: AccountRole;
  mutation?: boolean;
  permission?: FeaturePermission;
}

/** Session, CSRF (mutations), role and permission. Throws AuthError subclasses. */
export async function staffCaller(request: Request, options: StaffOptions): Promise<StaffCaller> {
  const session = await requireSession(request);
  if (options.mutation) await assertMutation(request, session);
  if (!hasMinRole(session.role, options.min)) throw new ForbiddenError('Insufficient workspace role');
  const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
  if (options.permission) await requirePermission(tenant, options.permission);
  return { tenant, accountId: session.accountId, userId: session.userId, role: session.role };
}

/** A tenant transaction gated on the appointments plan feature. */
export function inTenant<T>(caller: StaffCaller, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant(caller.tenant, async (tx) => {
    await requireFeature(tx, caller.accountId, 'appointments');
    return work(tx);
  });
}

/** Per-workspace burst limit for staff mutations; null when allowed. */
export function mutationLimit(caller: StaffCaller): NextResponse | null {
  const result = checkRateLimit(`appointments:${caller.accountId}:${caller.userId}`, { limit: 120, windowMs: 60_000 });
  return result.success ? null : rateLimitResponse(result);
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: noStore });
}

/** AppointmentError -> { error, code, field?, detail? }; auth and plan errors as usual; anything else is a generic 500. */
export function appointmentErrorResponse(error: unknown): NextResponse {
  if (isAppointmentError(error)) {
    const extra = error instanceof AppointmentFieldError ? { field: error.field, detail: error.detail } : {};
    return json({ error: t(error.code), code: error.code, ...extra }, error.status);
  }
  return toErrorResponse(error);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Strip columns no browser should see (hold code) and the staff note unless allowed. */
export function publicRow<T extends { hold_code?: unknown; outcome_note?: unknown; price_minor?: unknown }>(row: T, canManage: boolean) {
  const { hold_code: _code, ...rest } = row;
  void _code;
  const out: Record<string, unknown> = { ...rest };
  if (!canManage) delete out.outcome_note;
  if (typeof out.price_minor === 'bigint') out.price_minor = Number(out.price_minor);
  return out;
}

/** BigInt-safe row mapping for services (price_minor is bigint in the database). */
export function serviceJson<T extends { price_minor?: unknown }>(row: T) {
  return { ...row, price_minor: typeof row.price_minor === 'bigint' ? Number(row.price_minor) : row.price_minor };
}

// ------------------------------------------------------------ configuration route factories
// Reads: any member. Writes: admins with appointments.settings (RLS also requires admin).

type Tx = TenantTransaction;
type IdContext = { params: Promise<{ id: string }> };

export function configCollection<T>(spec: {
  key: string;
  list: (tx: Tx, accountId: string, request: Request) => Promise<T[]>;
  create?: (tx: Tx, accountId: string, userId: string, body: unknown) => Promise<T>;
  map?: (row: T) => unknown;
}) {
  const map = spec.map ?? ((row: T) => row);
  return {
    GET: async (request: Request) => {
      try {
        const caller = await staffCaller(request, { min: 'viewer' });
        const rows = await inTenant(caller, (tx) => spec.list(tx, caller.accountId, request));
        return json({ [spec.key]: rows.map(map) });
      } catch (error) {
        return appointmentErrorResponse(error);
      }
    },
    POST: async (request: Request) => {
      try {
        if (!spec.create) return json({ error: 'Method not allowed' }, 405);
        const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'appointments.settings' });
        const limited = mutationLimit(caller);
        if (limited) return limited;
        const body = await readJson(request);
        const create = spec.create;
        const row = await inTenant(caller, (tx) => create(tx, caller.accountId, caller.userId, body));
        return json({ item: map(row) }, 201);
      } catch (error) {
        return appointmentErrorResponse(error);
      }
    },
  };
}

export function configItem<T>(spec: {
  update?: (tx: Tx, accountId: string, userId: string, id: string, body: unknown) => Promise<T>;
  remove?: (tx: Tx, accountId: string, userId: string, id: string) => Promise<void>;
  map?: (row: T) => unknown;
}) {
  const map = spec.map ?? ((row: T) => row);
  const guard = async (request: Request, context: IdContext) => {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'appointments.settings' });
    if (!isId(id)) throw new AppointmentError('not_found');
    return { id, caller };
  };
  return {
    PATCH: async (request: Request, context: IdContext) => {
      try {
        if (!spec.update) return json({ error: 'Method not allowed' }, 405);
        const { id, caller } = await guard(request, context);
        const limited = mutationLimit(caller);
        if (limited) return limited;
        const body = await readJson(request);
        const update = spec.update;
        const row = await inTenant(caller, (tx) => update(tx, caller.accountId, caller.userId, id, body));
        return json({ item: map(row) });
      } catch (error) {
        return appointmentErrorResponse(error);
      }
    },
    DELETE: async (request: Request, context: IdContext) => {
      try {
        if (!spec.remove) return json({ error: 'Method not allowed' }, 405);
        const { id, caller } = await guard(request, context);
        const limited = mutationLimit(caller);
        if (limited) return limited;
        const remove = spec.remove;
        await inTenant(caller, (tx) => remove(tx, caller.accountId, caller.userId, id));
        return json({ status: 'deleted' });
      } catch (error) {
        return appointmentErrorResponse(error);
      }
    },
  };
}
