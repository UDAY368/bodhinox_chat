import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each withTenant call gets a fake transaction that records the SQL values it was given.
const calls: { sql: string; values: unknown[] }[] = [];
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
    const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      calls.push({ sql, values });
      return sql.includes('INSERT INTO outbound_intents') ? [{ id: '00000000-0000-4000-8000-000000000001' }] : 1;
    };
    return fn({ $queryRaw: record, $executeRaw: record });
  },
}));

import { dispatchOnce, UncertainDispatchError } from './dispatch';
import { NoNumberError } from '@/lib/whatsapp/numbers';
import { InstagramGraphInputError } from '@/lib/instagram/graph';

const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';
const settled = () => calls.find((call) => call.sql.includes('UPDATE outbound_intents SET status='))?.values;

describe('dispatchOnce outcome', () => {
  beforeEach(() => { calls.length = 0; });

  it('marks an Instagram conversation refused on a WhatsApp path as failed and rethrows it', async () => {
    await expect(dispatchOnce(ACCOUNT, 'k1', async () => { throw new NoNumberError('other_channel'); }))
      .rejects.toBeInstanceOf(NoNumberError);
    expect(settled()?.[0]).toBe('failed');
  });

  it('marks a local Instagram input refusal as failed', async () => {
    await expect(dispatchOnce(ACCOUNT, 'k2', async () => { throw new InstagramGraphInputError('Invalid Instagram object id'); }))
      .rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(settled()?.[0]).toBe('failed');
  });

  it('still records any other failure as unknown and reports it as uncertain', async () => {
    await expect(dispatchOnce(ACCOUNT, 'k3', async () => { throw new Error('socket hang up'); }))
      .rejects.toBeInstanceOf(UncertainDispatchError);
    expect(settled()?.[0]).toBe('unknown');
  });
});
