import { resolveSession } from '@/lib/auth/session';
import { createServerStorageFacade } from '@/lib/storage/server';
import {
  createRealtimeChannel,
  removeRealtimeChannel,
} from '@/lib/realtime/client';
import { executeQuery } from '@/lib/repositories/crm';
import { executeRpc } from '@/lib/repositories/rpc';
import { buildQuery } from './builder';
import type { DataClient, Row, TenantContext } from './types';

export function createScopedClient(
  context: TenantContext,
  auth?: DataClient['auth'],
  worker = false
): DataClient {
  return {
    from: <T = Row>(resource: string) =>
      buildQuery<T[]>(resource, (spec) =>
        executeQuery(spec, context, false, worker)
      ),
    rpc: (name, args = {}) => executeRpc(name, args, context, false, worker),
    auth:
      auth ??
      ({
        getUser: async () => ({
          data: { user: null },
          error: { message: 'No user session for background client' },
        }),
        getSession: async () => ({ data: { session: null }, error: null }),
      } as unknown as DataClient['auth']),
    storage: createServerStorageFacade(context, worker),
    channel: createRealtimeChannel,
    removeChannel: removeRealtimeChannel,
  };
}
export async function createClient(request?: Request): Promise<DataClient> {
  const session = await resolveSession(request);
  const auth = {
    getUser: async () => ({
      data: { user: session?.user ?? null },
      error: null,
    }),
    getSession: async () => ({
      data: {
        session: session
          ? {
              user: session.user,
              expires_at: session.expiresAt,
              accountId: session.accountId,
              role: session.role,
            }
          : null,
      },
      error: null,
    }),
  } as unknown as DataClient['auth'];
  if (session) return createScopedClient(session, auth);
  return {
    from: <T = Row>(resource: string) =>
      buildQuery<T[]>(resource, async () => ({
        data: null,
        error: { message: 'Authentication required', code: 'UNAUTHENTICATED' },
      })),
    rpc: async () => ({
      data: null,
      error: { message: 'Authentication required', code: 'UNAUTHENTICATED' },
    }),
    auth,
    storage: createServerStorageFacade(
      { accountId: '', role: 'viewer' },
      false
    ),
    channel: createRealtimeChannel,
    removeChannel: removeRealtimeChannel,
  };
}
