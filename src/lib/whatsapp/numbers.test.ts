import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import {
  NoNumberError,
  assertNumberConnected,
  getNumberConfig,
  isNumberDisconnected,
  listNumbers,
  setDefaultNumber,
} from './numbers';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

type Row = { id: string; is_default: boolean; access_token: string; status?: string };
const gone = (r: Row) => r.status === 'disconnected' && r.access_token === '';

function fakeTx(rows: Row[]) {
  const findMany = vi.fn(async (args: { take?: number; select?: object; where?: { status?: string; NOT?: object } }) =>
    rows
      .filter((r) => (args.where?.status ? gone(r) : args.where?.NOT ? !gone(r) : true))
      .sort((x, y) => Number(y.is_default) - Number(x.is_default))
      .slice(0, args.take ?? rows.length));
  const findFirst = vi.fn(async (args: { where: { id: string } }) => rows.find((r) => r.id === args.where.id) ?? null);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const $queryRaw = vi.fn(async () => rows.map((r) => ({ id: r.id, removed: gone(r) })));
  const tx = { whatsapp_config: { findMany, findFirst, updateMany }, $queryRaw } as unknown as TenantTransaction;
  return { tx, findMany, findFirst, updateMany };
}

describe('getNumberConfig', () => {
  it('prefers the default, then the only number', async () => {
    expect((await getNumberConfig(fakeTx([{ id: A, is_default: false, access_token: 'x' }, { id: B, is_default: true, access_token: 'y' }]).tx, 'acct')).id).toBe(B);
    expect((await getNumberConfig(fakeTx([{ id: A, is_default: false, access_token: 'x' }]).tx, 'acct')).id).toBe(A);
  });

  it('refuses to guess between several numbers with no default', async () => {
    const tx = fakeTx([{ id: A, is_default: false, access_token: 'x' }, { id: B, is_default: false, access_token: 'y' }]).tx;
    await expect(getNumberConfig(tx, 'acct')).rejects.toMatchObject({ reason: 'no_default' });
  });

  it('reports no number, and never falls back from a requested one', async () => {
    await expect(getNumberConfig(fakeTx([]).tx, 'acct')).rejects.toMatchObject({ reason: 'none' });
    const { tx, findFirst } = fakeTx([{ id: A, is_default: true, access_token: 'x' }]);
    await expect(getNumberConfig(tx, 'acct', B)).rejects.toMatchObject({ reason: 'not_found' });
    await expect(getNumberConfig(tx, 'acct', 'nope')).rejects.toBeInstanceOf(NoNumberError);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('disconnected numbers', () => {
  const removed = { id: A, is_default: false, access_token: '', status: 'disconnected' };

  it('is told apart from a number whose registration failed (that one keeps its token)', () => {
    expect(isNumberDisconnected(removed)).toBe(true);
    expect(isNumberDisconnected({ status: 'disconnected', access_token: 'enc' })).toBe(false);
    expect(isNumberDisconnected({ status: 'connected', access_token: 'enc' })).toBe(false);
    expect(() => assertNumberConnected(removed)).toThrow(expect.objectContaining({ reason: 'disconnected' }));
    expect(new NoNumberError('disconnected').messageKey).toBe('whatsappNumbers.errors.disconnected');
  });

  it('is never the default or only-number fallback, but is returned (with its status) when named', async () => {
    const { tx } = fakeTx([removed, { id: B, is_default: false, access_token: 'y', status: 'connected' }]);
    expect((await getNumberConfig(tx, 'acct')).id).toBe(B);
    await expect(getNumberConfig(fakeTx([removed]).tx, 'acct')).rejects.toMatchObject({ reason: 'none' });
    expect(await getNumberConfig(tx, 'acct', A)).toMatchObject({ id: A, status: 'disconnected' });
  });

  it('is listed with removed: true and cannot become the default', async () => {
    const { tx, updateMany } = fakeTx([removed, { id: B, is_default: true, access_token: 'y', status: 'connected' }]);
    expect((await listNumbers(tx, 'acct')).map((n) => [n.id, n.removed])).toEqual([[B, false], [A, true]]);
    await expect(setDefaultNumber(tx, 'acct', A)).rejects.toMatchObject({ reason: 'disconnected' });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('listNumbers', () => {
  it('never selects token or key columns', async () => {
    const { tx, findMany } = fakeTx([]);
    await listNumbers(tx, 'acct');
    const select = (findMany.mock.calls[0][0] as { select: Record<string, boolean> }).select;
    for (const secret of ['access_token', 'verify_token', 'verify_token_hash', 'forms_private_key_enc', 'forms_pending_private_key_enc'])
      expect(select).not.toHaveProperty(secret);
  });
});

describe('setDefaultNumber', () => {
  it('clears the old default before setting the new one', async () => {
    const { tx, updateMany } = fakeTx([{ id: A, is_default: true, access_token: 'x' }, { id: B, is_default: false, access_token: 'y' }]);
    await setDefaultNumber(tx, 'acct', B);
    expect(updateMany.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { where: { account_id: 'acct', is_default: true, NOT: { id: B } }, data: { is_default: false } },
      { where: { account_id: 'acct', id: B }, data: { is_default: true } },
    ]);
  });

  it('rejects a number the workspace cannot lock', async () => {
    const { tx, updateMany } = fakeTx([{ id: A, is_default: true, access_token: 'x' }]);
    await expect(setDefaultNumber(tx, 'acct', B)).rejects.toMatchObject({ reason: 'not_found' });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('NoNumberError', () => {
  it('maps each reason to a translation key', () => {
    expect(new NoNumberError('none').messageKey).toBe('whatsappNumbers.errors.none');
    expect(new NoNumberError('not_found').messageKey).toBe('whatsappNumbers.errors.notFound');
    expect(new NoNumberError('no_default').messageKey).toBe('whatsappNumbers.errors.noDefault');
  });
});
