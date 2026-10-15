import { createAuthClient, authFetch } from '@/lib/auth/client';
import { createStorageFacade } from '@/lib/storage/client';
import {
  createRealtimeChannel,
  removeRealtimeChannel,
} from '@/lib/realtime/client';
import { buildQuery } from './builder';
import { browserQuery } from './transport';
import type { DataClient, Row } from './types';

let client: DataClient | undefined;
export function createClient(): DataClient {
  return (client ??= {
    from: <T = Row>(resource: string) =>
      buildQuery<T[]>(resource, (spec) => browserQuery(spec, authFetch)),
    rpc: async (name, args = {}) => {
      const { browserRpc } = await import('./rpc-transport');
      return browserRpc(name, args, authFetch);
    },
    auth: createAuthClient(),
    storage: createStorageFacade(),
    channel: createRealtimeChannel,
    removeChannel: removeRealtimeChannel,
  });
}
