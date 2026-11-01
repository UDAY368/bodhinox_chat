import { NextResponse } from 'next/server';
import { toErrorResponse, type AccountContext } from '@/lib/auth/account';
import type { TenantContext } from '@/lib/db/tenant';
import { AudienceFilterError } from './filter';

/** The live session's tenant identity for segment and export queries. */
export const tenantOf = (ctx: AccountContext): TenantContext => ({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role });

/** Filter/segment input errors are 400 with a safe message; anything else is generic. */
export function audienceError(err: unknown): NextResponse {
  if (err instanceof AudienceFilterError) return NextResponse.json({ error: err.message }, { status: 400 });
  return toErrorResponse(err);
}
