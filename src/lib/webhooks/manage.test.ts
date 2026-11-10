// Stage 2: an endpoint's channel opt-in through the shared management module
// (dashboard and public API). Omitting `channels` keeps the WhatsApp-only
// default; a bad value is a 400, never stored.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';

vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (value: string) => `enc:${value}` }));

import { createWebhook, updateWebhook, WebhookInputError } from './manage';

const writes: { op: string; values: Record<string, unknown> }[] = [];
const db = {
  from: () => {
    let values: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      insert: (row: Record<string, unknown>) => { values = row; writes.push({ op: 'insert', values: row }); return b; },
      update: (row: Record<string, unknown>) => { values = row; writes.push({ op: 'update', values: row }); return b; },
      eq: () => b,
      select: () => b,
      single: async () => ({ data: { id: 'w1', created_at: 'now', ...values }, error: null }),
      maybeSingle: async () => ({ data: { id: 'w1', created_at: 'now', ...values }, error: null }),
    });
    return b;
  },
} as unknown as DataClient;

beforeEach(() => { writes.length = 0; });

describe('webhook channels', () => {
  const body = { url: 'https://example.com/hook', events: ['message.received'] };

  it('creates a WhatsApp-only endpoint when channels are omitted, as before Instagram', async () => {
    const created = await createWebhook(db, 'acct', 'user', body);
    expect(writes[0].values.channels).toEqual(['whatsapp']);
    expect(created.channels).toEqual(['whatsapp']);
    expect(created).toHaveProperty('secret');
  });

  it('stores an opt-in into Instagram in canonical order', async () => {
    const created = await createWebhook(db, 'acct', 'user', { ...body, channels: ['instagram', 'whatsapp'] });
    expect(writes[0].values.channels).toEqual(['whatsapp', 'instagram']);
    expect(created.channels).toEqual(['whatsapp', 'instagram']);
  });

  it.each([[[]], [['sms']], ['instagram'], [null]])('refuses channels %j without writing', async (channels) => {
    await expect(createWebhook(db, 'acct', 'user', { ...body, channels })).rejects.toBeInstanceOf(WebhookInputError);
    await expect(updateWebhook(db, 'acct', 'w1', { channels })).rejects.toBeInstanceOf(WebhookInputError);
    expect(writes).toEqual([]);
  });

  it('updates only the channels when that is all the body sends', async () => {
    const updated = await updateWebhook(db, 'acct', 'w1', { channels: ['instagram'] });
    expect(writes).toEqual([{ op: 'update', values: { channels: ['instagram'] } }]);
    expect(updated?.channels).toEqual(['instagram']);
  });
});
