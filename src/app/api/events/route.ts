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
  const resume = decodeEventCursor(
    request.headers.get('last-event-id') ?? url.searchParams.get('cursor')
  );
  const initial =
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
  let cursor = initial;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastResync = Date.now();
  const encoder = new TextEncoder();
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
      emit('resync', {
        reason: 'snapshot-required',
        cursor: encodeEventCursor(cursor),
      });
      const tick = async () => {
        if (stopped) return;
        try {
          if (context.expiresAt <= Date.now() / 1000) {
            emit('expired', {});
            stopped = true;
            controller.close();
            return;
          }
          const current = await resolveSession(request);
          if (
            !current ||
            current.accountId !== context.accountId ||
            current.userId !== context.userId
          ) {
            emit('revoked', {});
            stopped = true;
            controller.close();
            return;
          }
          // Re-read every tick so an admin's masking change applies to open streams.
          let mask = false;
          // Stage 5: a restricted agent's stream carries no event of a conversation they may not see.
          const restricted = visibilityRestricted(current.role);
          const rows = await withTenant(
            current,
            async (tx) => {
              mask = await loadPhoneMask(tx, current);
              return tx.$queryRaw<
              { id: string; at: string; payload: unknown }[]
            >`
            SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,payload FROM outbox_events
            WHERE account_id=${current.accountId}::uuid
              AND (created_at>${cursor.at}::timestamptz OR (created_at=${cursor.at}::timestamptz AND id>${cursor.id}::uuid))
              AND (recipient_user_id IS NULL OR recipient_user_id=${current.userId}::uuid)
              AND split_part(event_type,'.',1)=ANY(${requested}::text[])
              ${restricted ? Prisma.sql`AND ${conversationEventVisible}` : Prisma.empty}
            ORDER BY created_at,id LIMIT 200`;
            }
          );
          for (const row of rows) {
            cursor = { at: row.at, id: row.id };
            emit(
              'change',
              maskRealtimePayload(projectRealtimePayload(row.payload), mask),
              encodeEventCursor(cursor)
            );
          }
          // created_at is transaction time, not commit order. An occasional
          // authoritative snapshot repairs late commits and incremental drift.
          if (Date.now() - lastResync >= 30000) {
            emit('resync', {
              reason: 'periodic-snapshot',
              cursor: encodeEventCursor(cursor),
            });
            lastResync = Date.now();
          }
          if (!stopped) controller.enqueue(encoder.encode(': heartbeat\n\n'));
          if (!stopped)
            timer = setTimeout(tick, rows.length === 200 ? 50 : 2000);
        } catch {
          if (stopped) return;
          stopped = true;
          controller.error(new Error('Event stream unavailable'));
        }
      };
      request.signal.addEventListener(
        'abort',
        () => {
          stopped = true;
          if (timer) clearTimeout(timer);
          try {
            controller.close();
          } catch {}
        },
        { once: true }
      );
      await tick();
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
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
