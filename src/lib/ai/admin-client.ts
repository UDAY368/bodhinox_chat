import { createAdminClient } from '@/lib/data/admin';
import type { TenantContext } from '@/lib/data/types';
import { currentJobScope } from '@/lib/jobs/scope';
/** Constrained worker client: domain queries require an explicit or current tenant. */
export function databaseAdmin(context?: TenantContext) { return createAdminClient(context ?? currentJobScope()); }