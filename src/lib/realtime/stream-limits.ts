/** Timing and limits of the /api/events live-update stream (src/app/api/events/route.ts). */

/** Idle back-off: each empty read doubles the wait from POLL_FAST_MS up to POLL_IDLE_MAX_MS. */
export const POLL_FAST_MS = 2000;
export const POLL_IDLE_MAX_MS = 10_000;
/** With a healthy LISTEN connection a stream is woken by NOTIFY and only polls as a safety net. */
export const LISTEN_SAFETY_MS = 20_000;
/** The session is re-resolved at most this often; token expiry is still checked on every read. */
export const SESSION_RECHECK_MS = 20_000;
/** A comment line at least this often keeps proxies from closing a quiet stream. */
export const HEARTBEAT_MS = 15_000;
/** Minimum gap between reads when NOTIFY wakes arrive in bursts. */
export const WAKE_MIN_GAP_MS = 250;
/** created_at is transaction time, not commit order: an authoritative snapshot this often repairs late commits. */
export const PERIODIC_RESYNC_MS = 30_000;
/**
 * Concurrent streams per user in this process. The browser shares one stream per tab
 * (src/lib/realtime/client.ts), so 5 covers several tabs. The cap is per process, not
 * database-wide: with N web replicas a user can hold 5 x N. A database-held count would cost a
 * heartbeat write per open stream, which is the load this stream design removes.
 */
export const MAX_STREAMS_PER_USER = 5;

const store = globalThis as typeof globalThis & { bodhinoxEventStreams?: Map<string, number> };
const open = (): Map<string, number> => (store.bodhinoxEventStreams ??= new Map());

/** Takes a stream slot for the user; returns its release function (idempotent), or null over the cap. */
export function acquireStreamSlot(userId: string): (() => void) | null {
  const streams = open();
  const held = streams.get(userId) ?? 0;
  if (held >= MAX_STREAMS_PER_USER) return null;
  streams.set(userId, held + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (streams.get(userId) ?? 1) - 1;
    if (left > 0) streams.set(userId, left);
    else streams.delete(userId);
  };
}

export function openStreamCount(userId: string): number {
  return open().get(userId) ?? 0;
}
