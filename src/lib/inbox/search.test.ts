import { describe, expect, it, vi } from 'vitest';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  InboxSearchError,
  parseInboxSearchParams,
  phoneQueryDigits,
  searchInboxMessages,
  searchModeFor,
} from './search';
import { SNIPPET_END, SNIPPET_START } from './search-snippet';

const USER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const NUMBER = '33333333-3333-4333-8333-333333333333';
const MSG = '44444444-4444-4444-8444-444444444444';
const CONV = '55555555-5555-4555-8555-555555555555';
const params = (q: Record<string, string>) => new URLSearchParams(q);

describe('search modes', () => {
  it('picks phone, contains and fulltext', () => {
    expect(searchModeFor('+91 98765-43210')).toBe('phone');
    expect(phoneQueryDigits('+91 (98765) 43210')).toBe('919876543210');
    expect(phoneQueryDigits('123')).toBeNull();
    expect(searchModeFor('123')).toBe('fulltext');
    expect(searchModeFor('ok')).toBe('contains');
    expect(searchModeFor('ok!')).toBe('contains');
    expect(searchModeFor('refund')).toBe('fulltext');
    expect(searchModeFor('order 12')).toBe('fulltext');
  });
});

describe('cursor', () => {
  it('round-trips and rejects tampering', () => {
    const at = new Date('2026-11-02T10:00:00.123Z');
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(decodeSearchCursor(encodeSearchCursor(at, MSG))).toEqual({ createdAt: at, id: MSG });
    expect(decodeSearchCursor('nope')).toBeNull();
    expect(decodeSearchCursor(encode(['x', MSG]))).toBeNull();
    expect(decodeSearchCursor(encode([at.toISOString(), 'not-a-uuid OR 1=1']))).toBeNull();
  });
});

describe('parseInboxSearchParams', () => {
  it('parses a full request and resolves assignee=me', () => {
    const input = parseInboxSearchParams(params({
      q: '  late   order ', whatsapp_config_id: NUMBER, status: 'open', assignee: 'me',
      from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z', limit: '5',
    }), USER);
    expect(input).toEqual({
      query: 'late order',
      filters: { whatsappConfigId: NUMBER, status: 'open', assignee: USER,
        from: new Date('2026-11-01T00:00:00.000Z'), to: new Date('2026-11-02T00:00:00.000Z') },
      cursor: undefined,
      limit: 5,
    });
    expect(parseInboxSearchParams(params({ q: 'x', assignee: 'unassigned' }), USER).filters.assignee).toBe('unassigned');
    expect(parseInboxSearchParams(params({ q: 'x' }), USER).limit).toBe(20);
  });

  it.each([
    [{ q: '' }],
    [{ q: '   ...  ' }],
    [{ q: 'x'.repeat(801) }],
    [{ q: 'x', whatsapp_config_id: 'abc' }],
    [{ q: 'x', status: 'archived' }],
    [{ q: 'x', assignee: 'someone' }],
    [{ q: 'x', from: 'yesterday' }],
    [{ q: 'x', from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }],
    [{ q: 'x', cursor: 'garbage' }],
    [{ q: 'x', limit: '0' }],
    [{ q: 'x', limit: '51' }],
    [{ q: 'x', limit: '2.5' }],
  ])('rejects %o', (q) => {
    expect(() => parseInboxSearchParams(params(q), USER)).toThrow(InboxSearchError);
  });
});

/** Answers the three statements searchInboxMessages runs: timeout, membership, search. */
function fakeTx(rows: unknown[], membership: unknown[] = [{ mask_phone_numbers: false }]) {
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('statement_timeout')) return [];
      if (sql.includes('account_memberships')) return membership;
      return rows;
    }),
  } as never;
}

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  message_id: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`,
  conversation_id: CONV,
  created_at: new Date(Date.UTC(2026, 10, 2, 10, 0, 60 - n)),
  snippet: null,
  content_text: 'ok then',
  contact_name: null,
  contact_phone: '+919876543210',
  ...extra,
});

describe('searchInboxMessages', () => {
  const ctx = { accountId: ACCOUNT, userId: USER, role: 'agent' as const };
  const masked = [{ mask_phone_numbers: true }];

  it('pages with a cursor taken from the last returned row', async () => {
    const out = await searchInboxMessages(fakeTx([row(1), row(2), row(3)]), ctx, { query: 'ok', filters: {}, limit: 2 });
    expect(out.mode).toBe('contains');
    expect(out.results.map((r) => r.message_id)).toEqual([row(1).message_id, row(2).message_id]);
    expect(decodeSearchCursor(out.next_cursor!)).toEqual({ createdAt: row(2).created_at, id: row(2).message_id });
    expect(out.results[0].snippet).toBe(`${SNIPPET_START}ok${SNIPPET_END} then`);
  });

  it('returns no cursor on the last page and keeps ts_headline snippets', async () => {
    const hit = row(1, { snippet: `a ${SNIPPET_START}refund${SNIPPET_END}`, content_text: null, contact_name: 'Asha' });
    const out = await searchInboxMessages(fakeTx([hit]), ctx, { query: 'refund', filters: {}, limit: 2 });
    expect(out).toEqual({
      mode: 'fulltext',
      next_cursor: null,
      results: [{ message_id: hit.message_id, conversation_id: CONV, created_at: hit.created_at.toISOString(),
        snippet: `a ${SNIPPET_START}refund${SNIPPET_END}`, contact_name: 'Asha' }],
    });
  });

  it('masks the number shown in place of a missing name for masked members only', async () => {
    const input = { query: 'ok', filters: {}, limit: 5 };
    expect((await searchInboxMessages(fakeTx([row(1)], masked), ctx, input)).results[0].contact_name).toBe('+91 98•••••210');
    expect((await searchInboxMessages(fakeTx([row(1)]), ctx, input)).results[0].contact_name).toBe('+919876543210');
    const admin = await searchInboxMessages(fakeTx([row(1)], masked), { ...ctx, role: 'admin' }, input);
    expect(admin.results[0].contact_name).toBe('+919876543210');
  });

  it('fails closed to masked when the membership row is missing', async () => {
    const out = await searchInboxMessages(fakeTx([row(1)], []), ctx, { query: 'ok', filters: {}, limit: 5 });
    expect(out.results[0].contact_name).toBe('+91 98•••••210');
  });
});
