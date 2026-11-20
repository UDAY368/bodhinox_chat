import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { assertLocalTestDatabaseUrl, testDatabaseGuardActive } from '@/lib/db/test-db-guard';

/**
 * One LISTEN connection per web process wakes the open /api/events streams of an
 * account when outbox_events rows commit (trigger outbox_events_notify, payload =
 * account id only). It is an optimisation, never the source of truth: the streams
 * still read outbox_events by cursor, and while this listener is not confirmed
 * healthy they fall back to back-off polling.
 *
 * Health is proven, not assumed: after LISTEN, and then every minute, the listener
 * NOTIFYs itself and must hear its own ping within 5 s. A connection that cannot
 * deliver notifications (for example a transaction-mode pooler between the app and
 * PostgreSQL) therefore never counts as healthy. REALTIME_LISTEN=off disables it.
 */
export const OUTBOX_CHANNEL = 'bodhinox_outbox';
const PING_EVERY_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Wake = () => void;
type State = {
  client?: Client;
  healthy: boolean;
  started: boolean;
  retry: number;
  subscribers: Map<string, Set<Wake>>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  pingTimer?: ReturnType<typeof setTimeout>;
  pingDeadline?: ReturnType<typeof setTimeout>;
  pingNonce?: string;
};
const store = globalThis as typeof globalThis & { bodhinoxOutboxListener?: State };
const state = (): State => (store.bodhinoxOutboxListener ??= { healthy: false, started: false, retry: 0, subscribers: new Map() });

export function outboxListenerHealthy(): boolean {
  return state().healthy;
}

/** Calls wake when an outbox row of this account commits, or when listener health changes. */
export function onOutboxActivity(account: string, wake: Wake): () => void {
  const s = state();
  const accountId = account.toLowerCase();
  let set = s.subscribers.get(accountId);
  if (!set) s.subscribers.set(accountId, (set = new Set()));
  set.add(wake);
  if (!s.started) {
    s.started = true;
    void connect();
  }
  return () => {
    set!.delete(wake);
    if (!set!.size && s.subscribers.get(accountId) === set) s.subscribers.delete(accountId);
  };
}

function wakeAll(): void {
  for (const set of state().subscribers.values()) for (const wake of [...set]) wake();
}

function setHealthy(healthy: boolean): void {
  const s = state();
  if (s.healthy === healthy) return;
  s.healthy = healthy;
  // Healthy: streams resume reading now (rows may have committed while down).
  // Unhealthy: streams shorten their wait and poll.
  wakeAll();
}

function listenUrl(): string | undefined {
  if (process.env.REALTIME_LISTEN === 'off') return undefined;
  const value = process.env.DATABASE_URL;
  if (!value) return undefined;
  if (testDatabaseGuardActive()) assertLocalTestDatabaseUrl('DATABASE_URL', value);
  return value;
}

async function connect(): Promise<void> {
  const s = state();
  if (!s.started) return;
  let url: string | undefined;
  try {
    url = listenUrl();
  } catch {
    url = undefined;
  }
  if (!url) return; // Disabled or unconfigured: streams poll.
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, keepAlive: true });
  s.client = client;
  client.on('error', () => drop(client));
  client.on('end', () => drop(client));
  client.on('notification', (message) => {
    if (s.client !== client || message.channel !== OUTBOX_CHANNEL || !message.payload) return;
    if (message.payload === `ping:${s.pingNonce}`) {
      if (s.pingDeadline) clearTimeout(s.pingDeadline);
      s.pingDeadline = undefined;
      s.retry = 0;
      setHealthy(true);
      s.pingTimer = setTimeout(() => ping(client), PING_EVERY_MS);
      s.pingTimer.unref?.();
      return;
    }
    if (!uuid.test(message.payload)) return;
    for (const wake of [...(s.subscribers.get(message.payload.toLowerCase()) ?? [])]) wake();
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
    if (s.client !== client) return;
    await ping(client);
  } catch {
    drop(client);
  }
}

async function ping(client: Client): Promise<void> {
  const s = state();
  if (s.client !== client) return;
  s.pingNonce = randomUUID();
  if (s.pingDeadline) clearTimeout(s.pingDeadline);
  s.pingDeadline = setTimeout(() => drop(client), PING_TIMEOUT_MS);
  s.pingDeadline.unref?.();
  try {
    await client.query('SELECT pg_notify($1,$2)', [OUTBOX_CHANNEL, `ping:${s.pingNonce}`]);
  } catch {
    drop(client);
  }
}

function drop(client: Client): void {
  const s = state();
  if (s.client !== client) return;
  s.client = undefined;
  for (const timer of [s.pingTimer, s.pingDeadline]) if (timer) clearTimeout(timer);
  s.pingTimer = s.pingDeadline = undefined;
  client.removeAllListeners('notification');
  client.on('error', () => undefined);
  void client.end().catch(() => undefined);
  setHealthy(false);
  if (!s.started) return;
  // No error detail is logged: it can carry connection strings.
  console.warn('[realtime] outbox listener unavailable; live streams fall back to polling');
  const delay = Math.min(30_000, 1000 * 2 ** s.retry++);
  s.reconnectTimer = setTimeout(() => void connect(), delay);
  s.reconnectTimer.unref?.();
}

/** Closes the listener (tests and shutdown). Streams keep working by polling. */
export async function stopOutboxListener(): Promise<void> {
  const s = state();
  s.started = false;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  const client = s.client;
  if (client) drop(client);
  s.retry = 0;
}
