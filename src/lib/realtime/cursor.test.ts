import { expect, it } from 'vitest';
import { encodeEventCursor, decodeEventCursor } from './cursor';
it('preserves microseconds and rejects stale, future and injected event cursors', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const cursor = {
    at: '2026-10-14T11:59:59.123456Z',
    id: '11111111-1111-4111-8111-111111111111',
  };
  expect(decodeEventCursor(encodeEventCursor(cursor), now)).toEqual(cursor);
  expect(
    decodeEventCursor(
      encodeEventCursor({ ...cursor, at: '2026-10-14T11:00:00.000000Z' }),
      now
    )
  ).toBeNull();
  expect(
    decodeEventCursor(
      encodeEventCursor({ ...cursor, at: '2026-10-14T13:00:00.000000Z' }),
      now
    )
  ).toBeNull();
  expect(
    decodeEventCursor(
      encodeEventCursor({ ...cursor, id: 'DROP TABLE outbox_events' }),
      now
    )
  ).toBeNull();
});
