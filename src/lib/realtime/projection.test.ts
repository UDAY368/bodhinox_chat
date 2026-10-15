import { expect, it } from 'vitest';
import { projectRealtimePayload } from './projection';
it('strips internal creation markers from both outbox snapshots without modifying stored payloads', () => {
  const payload = {
    table: 'contacts',
    eventType: 'UPDATE',
    new: { id: 'c', name: 'New', inbound_created_meta_id: 'wamid.NEW' },
    old: { id: 'c', name: 'Old', inbound_created_meta_id: 'wamid.OLD' },
  };
  expect(projectRealtimePayload(payload)).toEqual({
    table: 'contacts',
    eventType: 'UPDATE',
    new: { id: 'c', name: 'New' },
    old: { id: 'c', name: 'Old' },
  });
  expect(payload.new.inbound_created_meta_id).toBe('wamid.NEW');
});
