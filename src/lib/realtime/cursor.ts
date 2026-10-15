export interface EventCursor {
  at: string;
  id: string;
}
export const EVENT_CURSOR_WINDOW_MS = 5 * 60 * 1000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Keep database microseconds in the cursor, rather than truncating through Date. */
export function encodeEventCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
export function decodeEventCursor(
  value: string | null,
  now = Date.now()
): EventCursor | null {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as EventCursor;
    if (
      Object.keys(cursor).sort().join(',') !== 'at,id' ||
      typeof cursor.at !== 'string' ||
      typeof cursor.id !== 'string' ||
      !uuid.test(cursor.id) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(cursor.at)
    )
      return null;
    const stamp = Date.parse(cursor.at);
    if (
      !Number.isFinite(stamp) ||
      stamp < now - EVENT_CURSOR_WINDOW_MS ||
      stamp > now + 5000
    )
      return null;
    return cursor;
  } catch {
    return null;
  }
}
