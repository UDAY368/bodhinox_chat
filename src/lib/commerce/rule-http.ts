/**
 * Route handlers shared by the price list, discount rule and gift rule APIs (store plan Phase 8):
 * agents and above read; admins create, replace (version-checked) and delete, under the admin
 * action rate limit. Bodies are validated to fixed shapes by each parser.
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import type { TenantContext } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { storeErrorResponse } from './store-settings';

type Admin = TenantContext & { userId: string };
type Params = { params: Promise<{ id: string }> };

export function collectionHandlers<I, V>(key: string, plural: string, singular: string, ops: {
  list: (ctx: TenantContext) => Promise<V[]>; parse: (body: unknown) => I; create: (ctx: Admin, input: I) => Promise<V>;
}) {
  return {
    async GET() {
      try {
        const ctx = await requireRole('agent');
        return NextResponse.json({ [plural]: await ops.list(tenantOf(ctx)) }, { headers: { 'Cache-Control': 'private, no-store' } });
      } catch (error) {
        return storeErrorResponse(error);
      }
    },
    async POST(request: Request) {
      try {
        const ctx = await requireRole('admin');
        const limit = await checkRateLimit(`commerce:${key}:${ctx.userId}`, RATE_LIMITS.adminAction);
        if (!limit.success) return rateLimitResponse(limit);
        const input = ops.parse(await request.json().catch(() => null));
        return NextResponse.json({ [singular]: await ops.create({ ...tenantOf(ctx), userId: ctx.userId }, input) }, { status: 201 });
      } catch (error) {
        return storeErrorResponse(error);
      }
    },
  };
}

export function itemHandlers<I, V>(key: string, singular: string, ops: {
  parse: (body: unknown) => I; update: (ctx: Admin, id: string, expectedVersion: unknown, input: I) => Promise<V>;
  remove: (ctx: Admin, id: string) => Promise<void>;
}) {
  return {
    async PATCH(request: Request, { params }: Params) {
      try {
        const ctx = await requireRole('admin');
        const limit = await checkRateLimit(`commerce:${key}:${ctx.userId}`, RATE_LIMITS.adminAction);
        if (!limit.success) return rateLimitResponse(limit);
        const { id } = await params;
        const body: unknown = await request.json().catch(() => null);
        const input = ops.parse(body);
        const row = await ops.update({ ...tenantOf(ctx), userId: ctx.userId }, id, (body as Record<string, unknown>).expected_version, input);
        return NextResponse.json({ [singular]: row });
      } catch (error) {
        return storeErrorResponse(error);
      }
    },
    async DELETE(_request: Request, { params }: Params) {
      try {
        const ctx = await requireRole('admin');
        const limit = await checkRateLimit(`commerce:${key}:${ctx.userId}`, RATE_LIMITS.adminAction);
        if (!limit.success) return rateLimitResponse(limit);
        const { id } = await params;
        await ops.remove({ ...tenantOf(ctx), userId: ctx.userId }, id);
        return NextResponse.json({ ok: true });
      } catch (error) {
        return storeErrorResponse(error);
      }
    },
  };
}
