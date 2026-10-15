import { createScopedClient } from './server';
import { buildQuery } from './builder';
import { executeQuery } from '@/lib/repositories/crm';
import { executeRpc } from '@/lib/repositories/rpc';
import type { DataClient, QuerySpec, Row, TenantContext } from './types';

export function scopeFromQuery(spec: QuerySpec): string | undefined {
  const scopes = spec.filters
    .filter((f) => f.field === 'account_id' && f.op === 'eq')
    .map((f) => f.value);
  const rows = spec.values
    ? Array.isArray(spec.values)
      ? spec.values
      : [spec.values]
    : [];
  scopes.push(...rows.map((row) => row.account_id).filter(Boolean));
  const unique = [...new Set(scopes)];
  return unique.length === 1 && typeof unique[0] === 'string'
    ? unique[0]
    : undefined;
}
/** Background callers must supply a scope or an explicit equality on account_id.
 * This is a constrained domain client, never a service-role/RLS bypass. */
export function createAdminClient(context?: TenantContext): DataClient {
  if (context)
    return createScopedClient(
      { ...context, role: context.role ?? 'owner' },
      undefined,
      true
    );
  const scoped = createScopedClient(
    { accountId: '', role: 'owner' },
    undefined,
    true
  );
  return {
    ...scoped,
    from: <T = Row>(resource: string) =>
      buildQuery<T[]>(resource, async (spec) => {
        const accountId = scopeFromQuery(spec);
        return accountId
          ? executeQuery(spec, { accountId, role: 'owner' }, false, true)
          : {
              data: null,
              error: {
                message: 'Background queries require an explicit tenant scope',
                code: 'TENANT_REQUIRED',
              },
            };
      }),
    rpc: async (name, args = {}) => {
      const accountId =
        typeof args.p_account_id === 'string'
          ? args.p_account_id
          : typeof args.account_id === 'string'
            ? args.account_id
            : undefined;
      return accountId
        ? executeRpc(name, args, { accountId, role: 'owner' }, false, true)
        : {
            data: null,
            error: {
              message: 'Background RPC requires an explicit tenant scope',
              code: 'TENANT_REQUIRED',
            },
          };
    },
  };
}
