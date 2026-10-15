import { authFetch } from '@/lib/auth/client';
export interface RealtimePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}
type Subscription = {
  table: string;
  filter?: string;
  event?: string;
  callback: (payload: RealtimePayload) => void;
};
const allowed = new Set([
  'messages',
  'conversations',
  'message_reactions',
  'notifications',
  'member_presence',
  'contacts',
  'deals',
  'broadcasts',
  'broadcast_recipients',
]);
/** Tenant/user authorization is enforced by the server; reconnects restore snapshots. */
export class RealtimeChannel {
  private source?: EventSource;
  private timer?: ReturnType<typeof setTimeout>;
  private subscriptions: Subscription[] = [];
  private resyncListeners: (() => void)[] = [];
  private status?: (status: string) => void;
  private cursor?: string;
  private disposed = false;
  private retry = 0;
  private seen = new Set<string>();
  constructor(readonly name: string) {}
  on(
    type: string,
    options: {
      table?: string;
      filter?: string;
      event?: string;
      schema?: string;
    },
    callback: (payload: RealtimePayload) => void
  ): this {
    if (
      type !== 'postgres_changes' ||
      !options.table ||
      !allowed.has(options.table) ||
      (options.schema && options.schema !== 'public')
    )
      throw new Error('Unsupported realtime resource');
    if (
      options.event &&
      !['*', 'INSERT', 'UPDATE', 'DELETE'].includes(options.event)
    )
      throw new Error('Unsupported realtime event');
    if (options.filter && !/^([a-z_]+)=eq\.(.{1,256})$/.test(options.filter))
      throw new Error('Unsupported realtime filter');
    this.subscriptions.push({
      table: options.table,
      filter: options.filter,
      event: options.event,
      callback,
    });
    return this;
  }
  onResync(callback: () => void): this {
    this.resyncListeners.push(callback);
    return this;
  }
  subscribe(callback?: (status: string) => void): this {
    this.status = callback;
    this.disposed = false;
    if (typeof EventSource === 'undefined' || !this.subscriptions.length) {
      callback?.('CHANNEL_ERROR');
      return this;
    }
    this.source?.close();
    if (this.timer) clearTimeout(this.timer);
    this.connect();
    return this;
  }
  private connect(): void {
    if (this.disposed) return;
    const params = new URLSearchParams({
      tables: [...new Set(this.subscriptions.map((s) => s.table))].join(','),
    });
    if (this.cursor) params.set('cursor', this.cursor);
    const source = (this.source = new EventSource(`/api/events?${params}`));
    source.onopen = () => {
      if (this.source !== source || this.disposed) return;
      this.retry = 0;
      this.status?.('SUBSCRIBED');
    };
    source.onerror = () => {
      if (this.source !== source) return;
      source.close();
      this.status?.('CHANNEL_ERROR');
      this.reconnect();
    };
    source.addEventListener('change', (event) => {
      if (this.source !== source || this.disposed) return;
      const message = event as MessageEvent;
      const eventId = message.lastEventId;
      if (eventId) {
        this.cursor = eventId;
        if (this.seen.has(eventId)) return;
        this.seen.add(eventId);
        if (this.seen.size > 2000)
          this.seen.delete(this.seen.values().next().value!);
      }
      let payload: RealtimePayload & { table: string };
      try {
        payload = JSON.parse(message.data);
      } catch {
        this.status?.('CHANNEL_ERROR');
        return;
      }
      if (
        !payload ||
        !allowed.has(payload.table) ||
        !['INSERT', 'UPDATE', 'DELETE'].includes(payload.eventType) ||
        !payload.new ||
        !payload.old
      )
        return;
      for (const subscription of this.subscriptions) {
        if (
          subscription.table !== payload.table ||
          (subscription.event &&
            subscription.event !== '*' &&
            subscription.event !== payload.eventType)
        )
          continue;
        if (subscription.filter) {
          const match = /^([a-z_]+)=eq\.(.+)$/.exec(subscription.filter)!;
          if (
            String(payload.new[match[1]] ?? payload.old[match[1]]) !== match[2]
          )
            continue;
        }
        subscription.callback(payload);
      }
    });
    source.addEventListener('resync', (event) => {
      if (this.source !== source || this.disposed) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        if (typeof payload.cursor === 'string' && payload.cursor.length <= 256)
          this.cursor = payload.cursor;
      } catch {}
      for (const listener of this.resyncListeners) listener();
    });
    source.addEventListener('expired', () => {
      if (this.source !== source) return;
      source.close();
      this.status?.('CHANNEL_ERROR');
      this.reconnect();
    });
    source.addEventListener('revoked', () => {
      if (this.source !== source) return;
      void this.unsubscribe();
      this.status?.('CLOSED');
    });
  }
  private reconnect(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(async () => {
      if (this.disposed) return;
      try {
        const response = await authFetch('/api/auth/session', {
          cache: 'no-store',
        });
        if (this.disposed) return;
        if (response.status === 401 || response.status === 403) {
          await this.unsubscribe();
          this.status?.('CLOSED');
          return;
        }
        if (!response.ok) {
          this.reconnect();
          return;
        }
        this.connect();
      } catch {
        if (!this.disposed) this.reconnect();
      }
    }, delay);
  }
  async unsubscribe(): Promise<'ok'> {
    this.disposed = true;
    this.source?.close();
    this.source = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return 'ok';
  }
}
export function createRealtimeChannel(name: string) {
  return new RealtimeChannel(name);
}
export async function removeRealtimeChannel(channel: RealtimeChannel) {
  return channel.unsubscribe();
}
