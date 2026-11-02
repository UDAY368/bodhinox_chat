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
it('gives INSERT and DELETE events an empty object for the missing side', () => {
  expect(projectRealtimePayload({ table: 'messages', eventType: 'INSERT', new: { id: 'm' }, old: null })).toEqual({
    table: 'messages', eventType: 'INSERT', new: { id: 'm' }, old: {},
  });
  expect(projectRealtimePayload({ table: 'messages', eventType: 'DELETE', new: null, old: { id: 'm' } })).toEqual({
    table: 'messages', eventType: 'DELETE', new: {}, old: { id: 'm' },
  });
});
it('sends note events without the note text or mentions', () => {
  const note = {
    id: 'n', account_id: 'a', conversation_id: 'c', author_id: 'u', body: 'Customer is VIP',
    mentions: ['u2'], created_at: 't', edited_at: null, deleted_at: null,
  };
  const out = projectRealtimePayload({ table: 'conversation_notes', eventType: 'UPDATE', new: note, old: note }) as Record<string, Record<string, unknown>>;
  for (const side of [out.new, out.old]) {
    expect(side).toEqual({ id: 'n', account_id: 'a', conversation_id: 'c', author_id: 'u', created_at: 't', edited_at: null, deleted_at: null });
    expect(JSON.stringify(side)).not.toContain('VIP');
  }
});
