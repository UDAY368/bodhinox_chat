/**
 * Shared plumbing for the staff catalogue and inventory APIs
 * (/api/commerce/shop/**, /api/commerce/inventory/**).
 *
 * Every handler: a live session (JWT + current membership + live session row),
 * Origin + CSRF proof on mutations (also enforced by the proxy), a minimum
 * role and, where it applies, a feature permission; then a withTenant
 * transaction so RLS applies underneath. Errors are code-only.
 */
import { NextResponse } from 'next/server';
import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { requirePermission, type FeaturePermission } from '@/lib/auth/permissions';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { CatalogueError } from '@/lib/commerce/catalogue/products';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const noStore = { 'Cache-Control': 'private, no-store' };
const t = getT('Commerce.catalogue.errors');

export interface StaffCaller {
  tenant: TenantContext & { userId: string; role: AccountRole };
  accountId: string;
  userId: string;
}

export async function staffCaller(request: Request, options: { min: AccountRole; mutation?: boolean; permission?: FeaturePermission }):
  Promise<StaffCaller> {
  const session = await requireSession(request);
  if (options.mutation) await assertMutation(request, session);
  if (!hasMinRole(session.role, options.min)) throw new ForbiddenError('Insufficient workspace role');
  const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
  if (options.permission) await requirePermission(tenant, options.permission);
  return { tenant, accountId: session.accountId, userId: session.userId };
}

export function inTenant<T>(caller: StaffCaller, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant(caller.tenant, work);
}

/** Per-member burst limit for catalogue writes; null when allowed. */
export function mutationLimit(caller: StaffCaller): NextResponse | null {
  const result = checkRateLimit(`catalogue:${caller.accountId}:${caller.userId}`, { limit: 120, windowMs: 60_000 });
  return result.success ? null : rateLimitResponse(result);
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: noStore });
}

/** CatalogueError -> { error, code, field?, detail? }; auth errors as usual; anything else a generic 500. */
export function catalogueErrorResponse(error: unknown): NextResponse {
  if (error instanceof CatalogueError) {
    return json({ error: t(error.code), code: error.code, ...(error.field ? { field: error.field } : {}),
      ...(error.detail ? { detail: error.detail } : {}) }, error.status);
  }
  return toErrorResponse(error);
}

export type IdContext = { params: Promise<{ id: string }> };
