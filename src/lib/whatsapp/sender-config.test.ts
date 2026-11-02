import { describe, expect, it } from 'vitest';
import type { DataClient } from '@/lib/data/types';
import { NoNumberError } from './numbers';
import {
  assertTemplateOnNumber,
  loadConversationSenderConfig,
  loadPickableNumbers,
  loadSenderConfig,
  loadSenderConfigByPhoneNumberId,
  numberErrorText,
  pickDefaultNumber,
  TemplateNumberMismatchError,
} from './sender-config';

const A = '11111111-1111-4111-8111-11111111111a';
const B = '22222222-2222-4222-8222-22222222222b';
const NUMBERS = [
  { id: B, account_id: 'acct', phone_number_id: '2000', access_token: 'enc-b', waba_id: 'waba-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
  { id: A, account_id: 'acct', phone_number_id: '1000', access_token: 'enc-a', waba_id: 'waba-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
];

/** Filters rows by every eq() so a foreign workspace's number never matches. */
function fakeDb(numbers: Record<string, unknown>[], conversation: Record<string, unknown> | null = null): DataClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const rows = () => (table === 'whatsapp_config' ? numbers : conversation ? [conversation] : [])
        .filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v));
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (field: string, value: unknown) => {
          filters[field] = value;
          return b;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
      };
      return b;
    },
  } as unknown as DataClient;
}

describe('loadSenderConfig', () => {
  it('returns the default number, else the only one', async () => {
    await expect(loadSenderConfig(fakeDb(NUMBERS), 'acct')).resolves.toMatchObject({ id: A });
    await expect(loadSenderConfig(fakeDb([{ ...NUMBERS[0], is_default: false }]), 'acct')).resolves.toMatchObject({ id: B });
  });

  it('returns the named number and never falls back to another', async () => {
    await expect(loadSenderConfig(fakeDb(NUMBERS), 'acct', B)).resolves.toMatchObject({ id: B });
    await expect(loadSenderConfig(fakeDb(NUMBERS), 'acct', '33333333-3333-4333-8333-333333333333'))
      .rejects.toMatchObject({ reason: 'not_found' });
    await expect(loadSenderConfig(fakeDb(NUMBERS), 'acct', 'not-a-uuid')).rejects.toMatchObject({ reason: 'not_found' });
  });

  it("does not return another workspace's number", async () => {
    await expect(loadSenderConfig(fakeDb(NUMBERS), 'other', B)).rejects.toMatchObject({ reason: 'not_found' });
    await expect(loadSenderConfig(fakeDb(NUMBERS), 'other')).rejects.toMatchObject({ reason: 'none' });
  });

  it('reports none and no_default', async () => {
    await expect(loadSenderConfig(fakeDb([]), 'acct')).rejects.toBeInstanceOf(NoNumberError);
    await expect(loadSenderConfig(fakeDb(NUMBERS.map((n) => ({ ...n, is_default: false }))), 'acct'))
      .rejects.toMatchObject({ reason: 'no_default' });
  });
});

describe('disconnected numbers', () => {
  // An admin-disconnected number keeps its row: status 'disconnected', token cleared.
  const off = (n: Record<string, unknown>) => ({ ...n, status: 'disconnected', access_token: '', is_default: false });

  it('refuses a named disconnected number with the disconnected reason, never another number', async () => {
    const error = await loadSenderConfig(fakeDb([off(NUMBERS[0]), NUMBERS[1]]), 'acct', B).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoNumberError);
    expect(error).toMatchObject({ reason: 'disconnected', messageKey: 'whatsappNumbers.errors.disconnected' });
  });

  it('refuses a disconnected number named by its Meta id', async () => {
    await expect(loadSenderConfigByPhoneNumberId(fakeDb([off(NUMBERS[0]), NUMBERS[1]]), 'acct', '2000'))
      .rejects.toMatchObject({ reason: 'disconnected' });
  });

  it('refuses the disconnected number a conversation is on instead of re-routing it', async () => {
    const onB = { id: 'cv', account_id: 'acct', whatsapp_config_id: B };
    await expect(loadConversationSenderConfig(fakeDb([off(NUMBERS[0]), NUMBERS[1]], onB), 'acct', 'cv'))
      .rejects.toMatchObject({ reason: 'disconnected' });
  });

  it('ignores disconnected numbers when picking the default or the only number', async () => {
    // A is default and connected; B disconnected: A. A disconnected, B the only connected one: B.
    await expect(loadSenderConfig(fakeDb([off(NUMBERS[0]), NUMBERS[1]]), 'acct')).resolves.toMatchObject({ id: A });
    await expect(loadSenderConfig(fakeDb([NUMBERS[0], off(NUMBERS[1])]), 'acct')).resolves.toMatchObject({ id: B });
  });

  it('reads as not configured, not "choose a number", when every number is disconnected', async () => {
    await expect(loadSenderConfig(fakeDb(NUMBERS.map(off)), 'acct')).rejects.toMatchObject({ reason: 'none' });
  });

  it('keeps sending from a number whose registration failed (disconnected but with its token)', async () => {
    const failed = { ...NUMBERS[0], status: 'disconnected' };
    await expect(loadSenderConfig(fakeDb([failed]), 'acct', B)).resolves.toMatchObject({ id: B });
  });

  it('pickDefaultNumber skips removed rows (listNumbers flag or status/token)', () => {
    const rows = [{ id: A, is_default: false, removed: true }, { id: B, is_default: false }];
    expect(pickDefaultNumber(rows)).toMatchObject({ id: B });
    expect(pickDefaultNumber([{ id: A, is_default: false, removed: true }])).toBeNull();
    expect(pickDefaultNumber([off(NUMBERS[0]), NUMBERS[1]])).toMatchObject({ id: A });
  });
});

describe('loadSenderConfigByPhoneNumberId', () => {
  it("finds this workspace's number by its Meta id only", async () => {
    await expect(loadSenderConfigByPhoneNumberId(fakeDb(NUMBERS), 'acct', '2000')).resolves.toMatchObject({ id: B });
    await expect(loadSenderConfigByPhoneNumberId(fakeDb(NUMBERS), 'other', '2000')).rejects.toMatchObject({ reason: 'not_found' });
    await expect(loadSenderConfigByPhoneNumberId(fakeDb(NUMBERS), 'acct', '20,00')).rejects.toMatchObject({ reason: 'not_found' });
  });
});

describe('loadConversationSenderConfig', () => {
  it("uses the conversation's number, and the default for a legacy conversation", async () => {
    const onB = { id: 'cv', account_id: 'acct', whatsapp_config_id: B };
    await expect(loadConversationSenderConfig(fakeDb(NUMBERS, onB), 'acct', 'cv')).resolves.toMatchObject({ id: B });
    const legacy = { id: 'cv', account_id: 'acct', whatsapp_config_id: null };
    await expect(loadConversationSenderConfig(fakeDb(NUMBERS, legacy), 'acct', 'cv')).resolves.toMatchObject({ id: A });
  });
});

describe('assertTemplateOnNumber', () => {
  it("refuses only a template stamped with another WABA than the number's", () => {
    expect(() => assertTemplateOnNumber({ waba_id: 'waba-a' }, { waba_id: 'waba-b' })).toThrow(TemplateNumberMismatchError);
    expect(() => assertTemplateOnNumber({ waba_id: 'waba-a' }, { waba_id: 'waba-a' })).not.toThrow();
    expect(() => assertTemplateOnNumber({ waba_id: null }, { waba_id: 'waba-b' })).not.toThrow();
    expect(() => assertTemplateOnNumber({ waba_id: 'waba-a' }, { waba_id: null })).not.toThrow();
    expect(() => assertTemplateOnNumber(null, { waba_id: 'waba-b' })).not.toThrow();
  });

  it('has readable text before and after the catalogue gains the key', () => {
    expect(numberErrorText(new TemplateNumberMismatchError())).toMatch(/WhatsApp Business account/);
    expect(numberErrorText(new NoNumberError('no_default'))).toMatch(/WhatsApp number/);
  });
});

describe('loadPickableNumbers', () => {
  /** Records each select() so the test can prove no token column is read. */
  function recordingDb(numbers: Record<string, unknown>[]) {
    const selects: string[] = [];
    const inner = fakeDb(numbers);
    const db = {
      from(table: string) {
        const b = inner.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
        const select = b.select;
        b.select = (columns: unknown) => { selects.push(String(columns)); return select(columns); };
        return b;
      },
    } as unknown as DataClient;
    return { db, selects };
  }
  const off = (row: Record<string, unknown>) => ({ ...row, is_default: false, status: 'disconnected', access_token: '' });

  it('marks a disconnected number removed without selecting any token', async () => {
    const { db, selects } = recordingDb([off(NUMBERS[1]), { ...NUMBERS[0], status: 'connected', is_default: false }]);
    const rows = await loadPickableNumbers(db, 'acct');
    expect(rows?.map((row) => [row.id, row.removed])).toEqual([[A, true], [B, false]]);
    expect(selects.join(',')).not.toMatch(/access_token|\*/);
    expect(pickDefaultNumber(rows!)?.id).toBe(B);
  });

  it('keeps a failed-registration number (status disconnected, token kept) pickable', async () => {
    const { db } = recordingDb([{ ...NUMBERS[0], status: 'disconnected' }]);
    const rows = await loadPickableNumbers(db, 'acct');
    expect(rows?.[0]).toMatchObject({ id: B, removed: false });
  });

  it('skips the second lookup when no number is disconnected', async () => {
    const { db, selects } = recordingDb(NUMBERS);
    await loadPickableNumbers(db, 'acct');
    expect(selects).toEqual(['id,is_default,created_at,status']);
  });
});
