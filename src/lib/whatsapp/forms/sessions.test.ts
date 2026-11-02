import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { createFormSession, findSessionByToken, isFlowToken, newFlowToken } from './sessions';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const FORM = '22222222-2222-4222-8222-222222222222';

/** Records each tagged-template query with its bound values. */
function fakeTx(rows: unknown[] = [{ id: 'session-1' }]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?'), values });
    return Promise.resolve(rows);
  };
  const tx = { $queryRaw: vi.fn(record), $executeRaw: vi.fn(record) };
  return { tx: tx as unknown as TenantTransaction, calls };
}

describe('flow tokens', () => {
  it('are 32 random bytes in base64url, never repeated', () => {
    const tokens = new Set(Array.from({ length: 200 }, newFlowToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(isFlowToken(token)).toBe(true);
    }
  });

  it('rejects anything that is not token-shaped', () => {
    for (const bad of ['', 'short', 'a'.repeat(42), `${'a'.repeat(43)}=`, `${'a'.repeat(42)}/`, null, 42]) {
      expect(isFlowToken(bad)).toBe(false);
    }
  });
});

describe('createFormSession', () => {
  it('stores a fresh token with the form, contact, run and expiry', async () => {
    const { tx, calls } = fakeTx();
    const before = Date.now();
    const session = await createFormSession(tx, { accountId: ACCOUNT, formId: FORM, contactId: 'c', conversationId: 'v', flowRunId: 'r', nodeKey: 'n', ttlHours: 2 });
    expect(session.sessionId).toBe('session-1');
    expect(isFlowToken(session.flowToken)).toBe(true);
    expect(calls[0].sql).toContain('INSERT INTO whatsapp_form_sessions');
    expect(calls[0].values).toEqual([ACCOUNT, session.flowToken, FORM, 'c', 'v', 'r', 'n', session.expiresAt]);
    const ttl = session.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(ttl).toBeLessThan(2 * 3_600_000 + 5_000);
  });

  it('clamps the lifetime to between one hour and 30 days', async () => {
    const { tx } = fakeTx();
    const short = await createFormSession(tx, { accountId: ACCOUNT, formId: FORM, ttlHours: 0 });
    const long = await createFormSession(tx, { accountId: ACCOUNT, formId: FORM, ttlHours: 10_000 });
    expect(Math.round((short.expiresAt.getTime() - Date.now()) / 3_600_000)).toBe(1);
    expect(Math.round((long.expiresAt.getTime() - Date.now()) / 3_600_000)).toBe(720);
  });

  it('issues a different token on every send', async () => {
    const { tx } = fakeTx();
    const a = await createFormSession(tx, { accountId: ACCOUNT, formId: FORM, ttlHours: 1 });
    const b = await createFormSession(tx, { accountId: ACCOUNT, formId: FORM, ttlHours: 1 });
    expect(a.flowToken).not.toBe(b.flowToken);
  });
});

describe('findSessionByToken', () => {
  it('never queries for a malformed token', async () => {
    const { tx, calls } = fakeTx();
    expect(await findSessionByToken(tx, ACCOUNT, 'nope')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('looks the token up within the account', async () => {
    const { tx, calls } = fakeTx([{ id: 's1', form_id: FORM }]);
    const token = newFlowToken();
    expect(await findSessionByToken(tx, ACCOUNT, token)).toMatchObject({ id: 's1' });
    expect(calls[0].sql).toContain('account_id=');
    expect(calls[0].values).toEqual([ACCOUNT, token]);
  });
});
