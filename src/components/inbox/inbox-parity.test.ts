import { describe, expect, it } from 'vitest';
import type { Message, QuickReply } from '@/types';
import { matchQuickReplies, slashQuery } from './composer-extras';
import { parseLocationForm } from './location-dialog';
import { buildTimeline } from './message-thread';
import { contactSearchTerm } from './new-message-dialog';
import type { ConversationNoteView } from './notes/notes-panel';

const qr = (id: string, title: string, text: string): QuickReply => ({
  id, account_id: 'a', user_id: 'u', title, kind: 'text', content_text: text, created_at: '', updated_at: '',
});

describe('slash quick replies', () => {
  it('reads a slash command only while the draft is one word after /', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/Ord')).toBe('ord');
    expect(slashQuery('/ord now')).toBeNull();
    expect(slashQuery('hello /ord')).toBeNull();
  });

  it('puts name prefixes first, then names or text containing the query, at most 8', () => {
    const items = [qr('1', 'thanks', 'Thank you for the order'), qr('2', 'order', 'Your order shipped'), qr('3', 'hours', 'We open at 9')];
    expect(matchQuickReplies(items, 'ord').map((q) => q.id)).toEqual(['2', '1']);
    expect(matchQuickReplies(items, '').map((q) => q.id)).toEqual(['1', '2', '3']);
    expect(matchQuickReplies(Array.from({ length: 12 }, (_, i) => qr(String(i), `r${i}`, 'x')), '')).toHaveLength(8);
  });
});

describe('location form', () => {
  it('accepts a point in range with optional name and address, and a comma decimal', () => {
    expect(parseLocationForm({ name: ' Store ', address: '', latitude: '17,41', longitude: '78.44' }))
      .toEqual({ ok: true, location: { latitude: 17.41, longitude: 78.44, name: 'Store' } });
  });

  it('names the wrong field', () => {
    expect(parseLocationForm({ name: '', address: '', latitude: '', longitude: '1' })).toEqual({ ok: false, field: 'latitude' });
    expect(parseLocationForm({ name: '', address: '', latitude: '1', longitude: '200' })).toEqual({ ok: false, field: 'longitude' });
  });
});

describe('new message contact search', () => {
  it('strips pattern characters', () => {
    expect(contactSearchTerm('  50%_off (vip), \\x ')).toBe('50off vip x');
  });
});

describe('thread timeline', () => {
  const msg = (id: string, at: string) => ({ id, created_at: at, conversation_id: 'c', sender_type: 'customer', content_type: 'text', status: 'read' }) as Message;
  const note = (id: string, at: string) => ({ id, conversation_id: 'c', author_id: 'u', body: 'n', mentions: [], created_at: at, edited_at: null }) as ConversationNoteView;

  it('merges notes among messages by time', () => {
    const items = buildTimeline(
      [msg('m1', '2026-11-13T10:00:00Z'), msg('m2', '2026-11-13T10:05:00Z')],
      [note('n2', '2026-11-13T10:06:00Z'), note('n1', '2026-11-13T10:02:00Z')],
      false
    );
    expect(items.map((i) => (i.kind === 'note' ? i.note.id : i.message.id))).toEqual(['m1', 'n1', 'm2', 'n2']);
  });

  it('holds back notes older than the loaded history', () => {
    const items = buildTimeline([msg('m1', '2026-11-13T10:00:00Z')], [note('old', '2026-11-12T09:00:00Z')], true);
    expect(items.map((i) => i.kind)).toEqual(['message']);
    expect(buildTimeline([msg('m1', '2026-11-13T10:00:00Z')], [note('old', '2026-11-12T09:00:00Z')], false)).toHaveLength(2);
  });
});
