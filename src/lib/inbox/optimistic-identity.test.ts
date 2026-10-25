import { expect, it } from 'vitest';
import type { Message } from '@/types';
import { applyRealtimeInsert, mergeFetchedPage } from './optimistic-messages';
const temp: Message = {
  id: 'temp-1',
  conversation_id: 'c',
  sender_type: 'agent',
  content_type: 'image',
  media_url: 'https://x/a.jpg',
  status: 'sending',
  created_at: '2026-01-01T12:00:00Z',
};
it('does not replace unrelated media or a much later identical send', () => {
  const other = {
    ...temp,
    id: 'row',
    media_url: 'https://x/b.jpg',
    status: 'sent' as const,
  };
  expect(applyRealtimeInsert([temp], other)).toHaveLength(2);
  const later = {
    ...other,
    media_url: temp.media_url,
    created_at: '2026-01-01T13:00:00Z',
  };
  expect(mergeFetchedPage([temp], [later], 'c')).toHaveLength(2);
});
it('updates an already confirmed row when a duplicate realtime insert fills in server metadata', () => {
  const confirmed = { ...temp, id: 'row', status: 'sent' as const };
  expect(
    applyRealtimeInsert([confirmed], { ...confirmed, message_id: 'wamid' })[0]
      .message_id
  ).toBe('wamid');
});
