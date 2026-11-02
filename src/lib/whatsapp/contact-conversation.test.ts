import { describe, expect, it } from 'vitest';
import type { DataClient } from '@/lib/data/types';
import { ContactConversationLookupError, pickContactConversationId } from './contact-conversation';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

/** Conversations come back in the order the query asked for (most recent first). */
function fakeDb(conversations: Record<string, unknown>[], numbers: Record<string, unknown>[], fail?: 'conversations' | 'whatsapp_config'): Pick<DataClient, 'from'> & { tables: string[] } {
  const tables: string[] = [];
  return {
    tables,
    from(table: string) {
      tables.push(table);
      const b: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit']) b[m] = () => b;
      b.eq = (field: string, value: unknown) => { filters[field] = value; return b; };
      // Number rows match the status / cleared-token filters (account_id is not on the fixtures).
      const matching = () => numbers.filter((row) =>
        Object.entries(filters).every(([field, value]) => field === 'account_id' || row[field] === value));
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(fail === table
          ? { data: null, error: { message: 'boom' } }
          : { data: table === 'conversations' ? conversations : matching(), error: null });
      return b;
    },
  } as unknown as Pick<DataClient, 'from'> & { tables: string[] };
}

describe('pickContactConversationId', () => {
  it('returns the only conversation without reading numbers (single-number workspaces)', async () => {
    const db = fakeDb([{ id: 'c1', whatsapp_config_id: A }], []);
    await expect(pickContactConversationId(db, 'acct', 'contact')).resolves.toBe('c1');
    expect(db.tables).toEqual(['conversations']);
    await expect(pickContactConversationId(fakeDb([], []), 'acct', 'contact')).resolves.toBeUndefined();
  });

  it("prefers the default number's conversation over a more recent one on another number", async () => {
    const db = fakeDb(
      [{ id: 'on-b', whatsapp_config_id: B }, { id: 'on-a', whatsapp_config_id: A }],
      [{ id: A, is_default: true, created_at: '2026-01-01' }, { id: B, is_default: false, created_at: '2026-02-01' }],
    );
    await expect(pickContactConversationId(db, 'acct', 'contact')).resolves.toBe('on-a');
  });

  it('falls back to an unnumbered conversation, then the most recent one', async () => {
    const numbers = [{ id: A, is_default: true, created_at: '2026-01-01' }, { id: B, is_default: false, created_at: '2026-02-01' }];
    await expect(pickContactConversationId(fakeDb(
      [{ id: 'on-b', whatsapp_config_id: B }, { id: 'legacy', whatsapp_config_id: null }], numbers,
    ), 'acct', 'contact')).resolves.toBe('legacy');
    await expect(pickContactConversationId(fakeDb(
      [{ id: 'recent', whatsapp_config_id: B }, { id: 'older', whatsapp_config_id: '00000000-0000-4000-8000-00000000000c' }],
      numbers.map((row) => ({ ...row, is_default: false })),
    ), 'acct', 'contact')).resolves.toBe('recent');
  });

  it('never falls back to a disconnected number as the only one', async () => {
    // A was disconnected; B is the only connected number, so its conversation wins over A's.
    const db = fakeDb(
      [{ id: 'on-a', whatsapp_config_id: A }, { id: 'on-b', whatsapp_config_id: B }],
      [
        { id: A, is_default: false, created_at: '2026-01-01', status: 'disconnected', access_token: '' },
        { id: B, is_default: false, created_at: '2026-02-01', status: 'connected', access_token: 'enc' },
      ],
    );
    await expect(pickContactConversationId(db, 'acct', 'contact')).resolves.toBe('on-b');
  });

  it('reports a failed lookup instead of guessing', async () => {
    await expect(pickContactConversationId(fakeDb([], [], 'conversations'), 'acct', 'contact'))
      .rejects.toBeInstanceOf(ContactConversationLookupError);
    await expect(pickContactConversationId(fakeDb([{ id: 'x', whatsapp_config_id: A }, { id: 'y', whatsapp_config_id: B }], [], 'whatsapp_config'), 'acct', 'contact'))
      .rejects.toBeInstanceOf(ContactConversationLookupError);
  });
});
