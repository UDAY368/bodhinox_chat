import { requireSession, resolveSession } from '@/lib/auth/session';
import { Prisma } from '@prisma/client';
import { withTenant } from '@/lib/db/tenant';
import { conversationIdVisibleSql, visibilityRestricted } from '@/lib/inbox/inbox-scope';
import { projectRealtimePayload } from '@/lib/realtime/projection';
import { loadPhoneMask, maskRealtimePayload } from '@/lib/inbox/masking-apply';
import {
  decodeEventCursor,
  encodeEventCursor,
  type EventCursor,
} from '@/lib/realtime/cursor';
import { onOutboxActivity, outboxListenerHealthy } from '@/lib/realtime/outbox-listener';
import {
  acquireStreamSlot,
  HEARTBEAT_MS,
  LISTEN_SAFETY_MS,
  PERIODIC_RESYNC_MS,
  POLL_FAST_MS,
  POLL_IDLE_MAX_MS,
  SESSION_RECHECK_MS,
  WAKE_MIN_GAP_MS,
} from '@/lib/realtime/stream-limits';
/**
 * Conversation, message and note events of a conversation hidden from the
 * member by agent visibility are left out (src/lib/inbox/inbox-scope.ts);
 * every other event passes. A conversation event names the conversation by
 * `id`, the others by `conversation_id`.
 */
const conversationEventVisible = Prisma.raw(`(split_part(event_type,'.',1) NOT IN ('conversations','messages','conversation_notes')
  OR ${conversationIdVisibleSql(`(CASE WHEN split_part(event_type,'.',1) = 'conversations'
      THEN COALESCE(payload->'new'->>'id', payload->'old'->>'id')
      ELSE COALESCE(payload->'new'->>'conversation_id', payload->'old'->>'conversation_id') END)::uuid`)})`);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const tables = new Set([
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
/**
 * One live-update stream per browser tab (the client multiplexes every
 * subscription onto it). A stream sleeps until a NOTIFY for its account wakes
 * it (src/lib/realtime/outbox-listener.ts); without a healthy listener it polls
 * with idle back-off (2 s doubling to 10 s, fast again on activity). The session
 * is re-resolved every SESSION_RECHECK_MS; token expiry is checked every read.
 */
export async function GET(request: Request) {
  let context;
  try {
    context = await requireSession(request);
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const requested = url.searchParams.get('tables')?.split(',') ?? [];
  if (
    !requested.length ||
    requested.length > tables.size ||
    requested.some((table) => !tables.has(table))
  )
    return new Response('Invalid event resources', { status: 400 });
  const release = acquireStreamSlot(context.userId);
  if (!release)
    return new Response('Too many live update streams', {
      status: 429,
      headers: { 'Retry-After': '10' },
    });
  const resume = decodeEventCursor(
    request.headers.get('last-event-id') ?? url.searchParams.get('cursor')
  );
  let initial: EventCursor;
  try {
    initial =
      resume ??
      (
        await withTenant(
          context,
          (tx) =>
            tx.$queryRaw<
              EventCursor[]
            >`SELECT to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,'00000000-0000-0000-0000-000000000000' AS id`
        )
      )[0];
  } catch (error) {
    release();
    throw error;
  }
  const session = context;
  const expiresAtMs = session.expiresAt * 1000;
  let current = session;
  let checkedAt = Date.now();
  // Phone masking is re-read with every session re-check, so an admin's change
  // reaches open streams within SESSION_RECHECK_MS.
  let mask: boolean | undefined;
  let cursor = initial;
  let stopped = false;
  let running = false;
  let wakePending = false;
  let lastTickAt = 0;
  let idleDelay = POLL_FAST_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => void) | undefined;
  let lastResync = Date.now();
  const encoder = new TextEncoder();
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    unlisten?.();
    release();
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, payload: unknown, id?: string) => {
        if (!stopped)
          controller.enqueue(
            encoder.encode(
              `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
            )
          );
      };
      const close = () => {
        stop();
        try {
          controller.close();
        } catch {}
      };
      const schedule = (delay: number) => {
        if (stopped) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, Math.max(0, delay));
      };
      emit('resync', {
        reason: 'snapshot-required',
        cursor: encodeEventCursor(cursor),
      });
      const tick = async (): Promise<void> => {
        if (stopped) return;
        if (running) {
          wakePending = true;
          return;
        }
        running = true;
        wakePending = false;
        lastTickAt = Date.now();
        try {
          if (expiresAtMs <= Date.now()) {
            emit('expired', {});
            close();
            return;
          }
          if (Date.now() - checkedAt >= SESSION_RECHECK_MS) {
            const fresh = await resolveSession(request);
            if (stopped) return;
            if (
              !fresh ||
              fresh.accountId !== session.accountId ||
              fresh.userId !== session.userId
            ) {
              emit('revoked', {});
              close();
              return;
            }
            current = fresh;
            checkedAt = Date.now();
            mask = undefined;
          }
          // Stage 5: a restricted agent's stream carries no event of a conversation they may not see.
          const reader = current;
          const restricted = visibilityRestricted(reader.role);
          const rows = await withTenant(reader, async (tx) => {
            if (mask === undefined) mask = await loadPhoneMask(tx, reader);
            return tx.$queryRaw<
              { id: string; at: string; payload: unknown }[]
            >`
            SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,payload FROM outbox_events
            WHERE account_id=${reader.accountId}::uuid
              AND (created_at>${cursor.at}::timestamptz OR (created_at=${cursor.at}::timestamptz AND id>${cursor.id}::uuid))
              AND (recipient_user_id IS NULL OR recipient_user_id=${reader.userId}::uuid)
              AND split_part(event_type,'.',1)=ANY(${requested}::text[])
              ${restricted ? Prisma.sql`AND ${conversationEventVisible}` : Prisma.empty}
            ORDER BY created_at,id LIMIT 200`;
          });
          if (stopped) return;
          for (const row of rows) {
            cursor = { at: row.at, id: row.id };
            emit(
              'change',
              maskRealtimePayload(projectRealtimePayload(row.payload), mask ?? true),
              encodeEventCursor(cursor)
            );
          }
          if (Date.now() - lastResync >= PERIODIC_RESYNC_MS) {
            emit('resync', {
              reason: 'periodic-snapshot',
              cursor: encodeEventCursor(cursor),
            });
            lastResync = Date.now();
          }
          // Idle back-off: 2 s, 4 s, 8 s, then 10 s; any row resets it to 2 s.
          const pollWait = rows.length ? POLL_FAST_MS : idleDelay;
          idleDelay = rows.length
            ? POLL_FAST_MS
            : Math.min(POLL_IDLE_MAX_MS, idleDelay * 2);
          const wait =
            rows.length === 200
              ? 50
              : wakePending
                ? WAKE_MIN_GAP_MS
                : outboxListenerHealthy()
                  ? LISTEN_SAFETY_MS
                  : pollWait;
          const now = Date.now();
          // Read again in time for the session re-check, the periodic resync and token expiry.
          schedule(
            Math.min(
              wait,
              checkedAt + SESSION_RECHECK_MS - now,
              lastResync + PERIODIC_RESYNC_MS - now,
              expiresAtMs - now
            )
          );
        } catch {
          if (stopped) return;
          stop();
          controller.error(new Error('Event stream unavailable'));
        } finally {
          running = false;
        }
      };
      // A NOTIFY for this account, or a listener health change, reads now,
      // at most once per WAKE_MIN_GAP_MS.
      unlisten = onOutboxActivity(session.accountId, () => {
        if (stopped) return;
        if (running) {
          wakePending = true;
          return;
        }
        schedule(lastTickAt + WAKE_MIN_GAP_MS - Date.now());
      });
      heartbeat = setInterval(() => {
        if (!stopped) controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, HEARTBEAT_MS);
      request.signal.addEventListener('abort', close, { once: true });
      await tick();
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
