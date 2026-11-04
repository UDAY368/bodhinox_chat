// How a context provider reaches the database for a request.
//
// A request for a member (userId set) runs on the app role as that member:
// row-level security applies exactly as for the member's own reads. A job
// request (userId null; the job already rechecked its requester) runs on the
// worker role scoped to the workspace. Either way every query also filters on
// account_id explicitly.

import type { PrismaClient } from '@prisma/client';
import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { createScopedClient } from '@/lib/data/server';
import { databaseAdmin } from '../admin-client';
import type { DataClient } from '@/lib/data/types';
import type { ContextRequest } from './core';

function tenantFor(request: ContextRequest): { ctx: TenantContext; db: PrismaClient } {
  return request.userId
    ? { ctx: { accountId: request.accountId, userId: request.userId, role: request.role }, db: getPrisma() }
    : { ctx: { accountId: request.accountId, role: 'owner' }, db: getWorkerPrisma() };
}

/** Runs `fn` in a tenant transaction for this request (member on the app role, or a job on the worker). */
export function withRequestTenant<T>(request: ContextRequest, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  const { ctx, db } = tenantFor(request);
  return withTenant(ctx, fn, db);
}

/** A data client for this request (the member's own scope, or the worker scoped to the workspace). */
export function dataClientFor(request: ContextRequest): DataClient {
  return request.userId
    ? createScopedClient({ accountId: request.accountId, userId: request.userId, role: request.role })
    : databaseAdmin({ accountId: request.accountId, role: 'owner' });
}
