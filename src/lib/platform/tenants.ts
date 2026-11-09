// Console tenant list and detail. Everything comes from crm_platform_tenants /
// crm_platform_tenant: ids, names, owner email, plan, statuses, member counts
// and the stored usage counters of the current month. No live counts, no
// customer content.

import { platformTenant, platformTenants } from './db';
import type { PlatformTenantDetail, PlatformTenantRow } from '@/types/platform';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export interface PageQuery {
  cursor: Date | null;
  limit: number;
}

/** cursor = an ISO timestamp from the previous page's nextCursor; limit 1..100 (default 50). Null when malformed. */
export function parsePageQuery(params: URLSearchParams): PageQuery | null {
  const rawCursor = params.get('cursor');
  let cursor: Date | null = null;
  if (rawCursor) {
    if (rawCursor.length > 40) return null;
    cursor = new Date(rawCursor);
    if (Number.isNaN(cursor.getTime())) return null;
  }
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  return { cursor, limit };
}

export interface TenantListRow extends PlatformTenantRow {
  /** A closing workspace past its purge date (the workspace.purge job deletes it when WORKSPACE_PURGE_ENABLED=true). */
  purgeDue: boolean;
}

export interface TenantPage {
  tenants: TenantListRow[];
  nextCursor: string | null;
}

export async function listTenants(input: { search: string | null } & PageQuery, now = Date.now()): Promise<TenantPage> {
  const search = input.search?.trim().slice(0, 200) || null;
  const rows = await platformTenants({ search, cursor: input.cursor, limit: input.limit });
  return {
    tenants: rows.map((row) => ({ ...row, purgeDue: isPurgeDue(row.lifecycleStatus, row.purgeAfter, now) })),
    nextCursor: rows.length === input.limit ? rows[rows.length - 1].createdAt : null,
  };
}

export function isPurgeDue(status: string, purgeAfter: string | null, now = Date.now()): boolean {
  return status === 'closing' && purgeAfter !== null && new Date(purgeAfter).getTime() <= now;
}

export async function getTenant(accountId: string): Promise<PlatformTenantDetail | null> {
  return isUuid(accountId) ? platformTenant(accountId.toLowerCase()) : null;
}
