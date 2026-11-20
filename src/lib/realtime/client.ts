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
  // Note events carry ids only (src/lib/realtime/projection.ts).
  'conversation_notes',
]);
/** Union changes (channels joining or leaving) are applied after this pause, so a page mounting several hooks opens one stream. */
export const HUB_REOPEN_DEBOUNCE_MS = 300;

/**
 * One EventSource per tab. Every RealtimeChannel registers here; the hub opens
 * a single /api/events stream for the union of their tables, resumes it with
 * the stored cursor on reconnect, and re-opens it (debounced) when the union
 * changes. Channels filter the shared events themselves.
 *
 * Resync: a newly joined channel always gets one (its snapshot), as do all
 * channels after an error reconnect and on the server's periodic snapshot. A
 * re-open for a union change resumes the cursor, so channels the previous
 * stream already served keep their state and are not asked to reload.
 */
class RealtimeHub {
  private channels = new Set<RealtimeChannel>();
  /** Channels waiting for their first resync. */
  private fresh = new Set<RealtimeChannel>();
  private source?: EventSource;
  private openTables = '';
  private open = false;
  private resyncAll = false;
  private cursor?: string;
  private seen = new Set<string>();
  private retry = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconcileTimer?: ReturnType<typeof setTimeout>;

  join(channel: RealtimeChannel): void {
    this.channels.add(channel);
    this.fresh.add(channel);
    if (this.source && this.open && this.covers(channel)) {
      queueMicrotask(() => {
        if (!this.channels.has(channel) || !this.fresh.delete(channel)) return;
        channel.notifyStatus('SUBSCRIBED');
        channel.notifyResync();
      });
      return;
    }
    this.schedule(this.source ? HUB_REOPEN_DEBOUNCE_MS : 0);
  }

  leave(channel: RealtimeChannel): void {
    if (!this.channels.delete(channel)) return;
    this.fresh.delete(channel);
    this.schedule(HUB_REOPEN_DEBOUNCE_MS);
  }

  /** Test hook: forget every channel and close the stream now. */
  reset(): void {
    this.channels.clear();
    this.closeAll();
  }

  private tables(): string {
    const union = new Set<string>();
    for (const channel of this.channels)
      for (const table of channel.tables()) union.add(table);
    return [...union].sort().join(',');
  }

  private covers(channel: RealtimeChannel): boolean {
    const open = new Set(this.openTables.split(','));
    return channel.tables().every((table) => open.has(table));
  }

  private schedule(delay: number): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      this.reconcile();
    }, delay);
  }

  private reconcile(): void {
    if (!this.channels.size) return this.closeAll();
    if (this.reconnectTimer) return; // the pending reconnect opens the current union
    const tables = this.tables();
    if (this.source && tables === this.openTables) return;
    this.connect();
  }

  private closeAll(): void {
    this.source?.close();
    this.source = undefined;
    this.open = false;
    this.openTables = '';
    this.cursor = undefined;
    this.seen.clear();
    this.retry = 0;
    this.fresh.clear();
    for (const timer of [this.reconnectTimer, this.reconcileTimer])
      if (timer) clearTimeout(timer);
    this.reconnectTimer = this.reconcileTimer = undefined;
  }

  private connect(): void {
    this.source?.close();
    this.open = false;
    const tables = this.tables();
    if (!tables) return;
    this.openTables = tables;
    const params = new URLSearchParams({ tables });
    if (this.cursor) params.set('cursor', this.cursor);
    const source = (this.source = new EventSource(`/api/events?${params}`));
    let first = true;
    source.onopen = () => {
      if (this.source !== source) return;
      this.open = true;
      this.retry = 0;
      for (const channel of this.channels) channel.notifyStatus('SUBSCRIBED');
    };
    source.onerror = () => {
      if (this.source !== source) return;
      this.fail();
    };
    source.addEventListener('change', (event) => {
      if (this.source !== source) return;
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
        for (const channel of this.channels)
          channel.notifyStatus('CHANNEL_ERROR');
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
      for (const channel of [...this.channels]) channel.deliver(payload);
    });
    source.addEventListener('resync', (event) => {
      if (this.source !== source) return;
      let reason: unknown;
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        reason = payload.reason;
        if (typeof payload.cursor === 'string' && payload.cursor.length <= 256)
          this.cursor = payload.cursor;
      } catch {}
      // The opening snapshot of a union-change re-open goes only to channels
      // that have not had one; anything else (periodic, after an error) goes to all.
      const onlyFresh =
        first && reason === 'snapshot-required' && !this.resyncAll;
      first = false;
      this.resyncAll = false;
      const targets = onlyFresh ? [...this.fresh] : [...this.channels];
      this.fresh.clear();
      for (const channel of targets)
        if (this.channels.has(channel)) channel.notifyResync();
    });
    source.addEventListener('expired', () => {
      if (this.source !== source) return;
      this.fail();
    });
    source.addEventListener('revoked', () => {
      if (this.source !== source) return;
      this.closeEverything();
    });
  }

  private fail(): void {
    this.source?.close();
    this.source = undefined;
    this.open = false;
    this.resyncAll = true;
    for (const channel of this.channels) channel.notifyStatus('CHANNEL_ERROR');
    this.reconnect();
  }

  /** Signed out or revoked: every channel is closed for good. */
  private closeEverything(): void {
    const channels = [...this.channels];
    this.channels.clear();
    this.closeAll();
    for (const channel of channels) channel.closedByServer();
  }

  private reconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(async () => {
      try {
        const response = await authFetch('/api/auth/session', {
          cache: 'no-store',
        });
        this.reconnectTimer = undefined;
        if (!this.channels.size) return this.closeAll();
        if (response.status === 401 || response.status === 403)
          return this.closeEverything();
        if (!response.ok) return this.reconnect();
        this.connect();
      } catch {
        this.reconnectTimer = undefined;
        if (this.channels.size) this.reconnect();
      }
    }, delay);
  }
}

const hubStore = globalThis as typeof globalThis & { bodhinoxRealtimeHub?: RealtimeHub };
const hub = (): RealtimeHub => (hubStore.bodhinoxRealtimeHub ??= new RealtimeHub());

/** Tenant/user authorization is enforced by the server; reconnects restore snapshots. */
export class RealtimeChannel {
  private subscriptions: Subscription[] = [];
  private resyncListeners: (() => void)[] = [];
  private status?: (status: string) => void;
  private joined = false;
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
    if (typeof EventSource === 'undefined' || !this.subscriptions.length) {
      callback?.('CHANNEL_ERROR');
      return this;
    }
    this.joined = true;
    hub().join(this);
    return this;
  }
  async unsubscribe(): Promise<'ok'> {
    if (this.joined) hub().leave(this);
    this.joined = false;
    return 'ok';
  }
  /** @internal hub use */
  tables(): string[] {
    return [...new Set(this.subscriptions.map((s) => s.table))];
  }
  /** @internal hub use */
  notifyStatus(status: string): void {
    if (this.joined) this.status?.(status);
  }
  /** @internal hub use */
  notifyResync(): void {
    if (!this.joined) return;
    for (const listener of this.resyncListeners) listener();
  }
  /** @internal hub use: the server revoked the session or refresh was denied. */
  closedByServer(): void {
    if (!this.joined) return;
    this.joined = false;
    this.status?.('CLOSED');
  }
  /** @internal hub use */
  deliver(payload: RealtimePayload & { table: string }): void {
    if (!this.joined) return;
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
        if (String(payload.new[match[1]] ?? payload.old[match[1]]) !== match[2])
          continue;
      }
      subscription.callback(payload);
    }
  }
}
export function createRealtimeChannel(name: string) {
  return new RealtimeChannel(name);
}
export async function removeRealtimeChannel(channel: RealtimeChannel) {
  return channel.unsubscribe();
}
/** Test hook: drops every channel and closes the shared stream. */
export function resetRealtimeHub(): void {
  hub().reset();
}
