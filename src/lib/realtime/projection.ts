import { internalFields } from '@/lib/data/contracts';

/**
 * Note events tell the browser which conversation's notes changed; the panel
 * re-reads them through GET /api/conversations/[id]/notes, so the note text
 * and mentions never travel on the event stream (soft-deleted text included).
 */
const NOTE_EVENT_FIELDS = new Set([
  'id',
  'account_id',
  'conversation_id',
  'author_id',
  'created_at',
  'edited_at',
  'deleted_at',
]);

/**
 * Outbox snapshots remain complete in PostgreSQL; browser events omit
 * internals. The outbox stores `old` as null for an INSERT and `new` as null
 * for a DELETE; the browser contract (src/lib/realtime/client.ts) expects an
 * object on both sides, so a missing side becomes {}.
 */
export function projectRealtimePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return payload;
  const event = payload as Record<string, unknown>;
  const keep = (key: string) =>
    !internalFields.has(key) &&
    (event.table !== 'conversation_notes' || NOTE_EVENT_FIELDS.has(key));
  const project = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => keep(key)))
      : value == null
        ? {}
        : value;
  return { ...event, new: project(event.new), old: project(event.old) };
}
