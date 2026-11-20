/**
 * Shared plumbing of the shop marketing routes (store plan Phase 8, batch 6): who may call (agents read, admins write; the
 * marketing writes are admin-only because they send email or move money) and the per-member write limit.
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import type { TenantContext } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export type Staff = TenantContext & { userId: string };

export async function readerOf(): Promise<TenantContext> {
  return tenantOf(await requireRole('agent'));
}

/** An admin, inside the write limit; or the ready 429 response. Throws the auth errors storeErrorResponse maps. */
export async function writerOf(scope: string): Promise<{ staff: Staff } | { response: NextResponse }> {
  const ctx = await requireRole('admin');
  const limit = await checkRateLimit(`commerce:${scope}:${ctx.userId}`, RATE_LIMITS.adminAction);
  if (!limit.success) return { response: rateLimitResponse(limit) };
  return { staff: { ...tenantOf(ctx), userId: ctx.userId } };
}

export const readBody = (request: Request) => request.json().catch(() => null);
