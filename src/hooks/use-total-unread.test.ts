import { describe, expect, it } from 'vitest';
import { applyUnreadChange, countUnread, rowChannel } from './use-total-unread';

type Rows = Parameters<typeof applyUnreadChange>[0];

describe('unread conversations split by channel', () => {
  it('counts conversations (not messages) per channel and in all', () => {
    expect(countUnread([
      { unread: 3, channel: 'whatsapp' },
      { unread: 1, channel: 'instagram' },
      { unread: 0, channel: 'instagram' },
      { unread: 2, channel: 'whatsapp' },
    ])).toEqual({ all: 3, whatsapp: 2, instagram: 1 });
    expect(countUnread([])).toEqual({ all: 0, whatsapp: 0, instagram: 0 });
  });

  it('counts legacy rows with no channel as WhatsApp', () => {
    expect(rowChannel(null)).toBe('whatsapp');
    expect(rowChannel(undefined)).toBe('whatsapp');
    expect(rowChannel('whatsapp')).toBe('whatsapp');
    expect(rowChannel('instagram')).toBe('instagram');
    expect(rowChannel('something-else')).toBe('whatsapp');
  });

  it('applies realtime inserts, updates and deletes to the right channel', () => {
    const rows: Rows = new Map();
    applyUnreadChange(rows, { eventType: 'INSERT', new: { id: 'a', unread_count: 2, channel: 'instagram' } });
    applyUnreadChange(rows, { eventType: 'INSERT', new: { id: 'b', unread_count: 1, channel: null } });
    expect(countUnread(rows.values())).toEqual({ all: 2, whatsapp: 1, instagram: 1 });

    applyUnreadChange(rows, { eventType: 'UPDATE', new: { id: 'a', unread_count: 0, channel: 'instagram' } });
    expect(countUnread(rows.values())).toEqual({ all: 1, whatsapp: 1, instagram: 0 });

    applyUnreadChange(rows, { eventType: 'DELETE', old: { id: 'b' } });
    expect(countUnread(rows.values())).toEqual({ all: 0, whatsapp: 0, instagram: 0 });
  });

  it('keeps the known channel when an update omits it', () => {
    const rows: Rows = new Map([['a', { unread: 0, channel: 'instagram' }]]);
    applyUnreadChange(rows, { eventType: 'UPDATE', new: { id: 'a', unread_count: 4 } });
    expect(rows.get('a')).toEqual({ unread: 4, channel: 'instagram' });
    // A row first seen without a channel is a legacy WhatsApp row.
    applyUnreadChange(rows, { eventType: 'UPDATE', new: { id: 'z', unread_count: 1 } });
    expect(rows.get('z')).toEqual({ unread: 1, channel: 'whatsapp' });
  });

  it('ignores a change without an id', () => {
    const rows: Rows = new Map();
    applyUnreadChange(rows, { eventType: 'UPDATE', new: { unread_count: 1 } });
    applyUnreadChange(rows, { eventType: 'DELETE', old: {} });
    expect(rows.size).toBe(0);
  });
});
