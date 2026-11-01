import { describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./meta-api', async (original) => ({ ...(await original<typeof import('./meta-api')>()), sendTemplateMessage: mocks.send }));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: async (_a: string, url: string) => url }));
vi.mock('@/lib/jobs/dispatch', () => ({ dispatchOnce: async (_account: string, _key: string, send: () => unknown) => send(), UncertainDispatchError: class extends Error {} }));
import { MetaApiError } from './meta-api';
import { deliverBroadcast, isThrottled, throttleDelayMs } from './broadcast-core';
import { appOrigin } from '@/lib/broadcasts/tracking';
import type { MessageTemplate } from '@/types';

/** Records every recipient update; counts read as zero so finalize is a no-op transition. */
function recordingDb() {
  const updates: { row: Record<string, unknown>; id: unknown }[] = [];
  let pending: Record<string, unknown> | null = null;
  const chain = {
    update: (row: Record<string, unknown>) => ((pending = row), chain),
    eq: (field: string, value: unknown) => {
      if (pending && field === 'id') updates.push({ row: pending, id: value });
      pending = null;
      return chain;
    },
    select: () => chain, neq: () => chain,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null, count: 0, data: [] }).then(resolve),
  };
  return { db: { from: () => chain } as unknown as DataClient, updates };
}

const plan = (ids: string[]) => ({
  broadcastId: 'b', templateName: 't', templateLanguage: 'en', phoneNumberId: 'pn', accessToken: 'x', templateRow: null, rejected: 0,
  planned: ids.map((id, i) => ({ recipientRowId: id, phone: `+1202555${String(i).padStart(4, '0')}`, params: [] as string[], clickToken: null as string | null })),
});
const options = { accountId: 'acct', assertLease: () => {}, attemptId: 'job' };
const throttle = () => new MetaApiError('Rate limit hit', { code: 130429, httpStatus: 400 });

describe('broadcast throttling', () => {
  it('pauses on a throttle code, leaving that recipient and the rest untouched', async () => {
    mocks.send.mockReset().mockResolvedValueOnce({ messageId: 'm1' }).mockRejectedValueOnce(throttle());
    const { db, updates } = recordingDb();
    expect(await deliverBroadcast(db, plan(['r1', 'r2', 'r3']), options)).toEqual({ throttled: true, sent: 1 });
    expect(updates.filter((u) => u.id !== 'b').map((u) => [u.id, u.row.status])).toEqual([['r1', 'sent']]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('records any other rejection as a final failure and carries on', async () => {
    mocks.send.mockReset()
      .mockRejectedValueOnce(new MetaApiError('Template does not exist', { code: 132001, httpStatus: 404 }))
      .mockResolvedValueOnce({ messageId: 'm2' });
    const { db, updates } = recordingDb();
    expect(await deliverBroadcast(db, plan(['r1', 'r2']), options)).toEqual({ throttled: false, sent: 1 });
    expect(updates.filter((u) => u.id !== 'b').map((u) => [u.id, u.row.status])).toEqual([['r1', 'failed'], ['r2', 'sent']]);
  });

  it('aborts on a lost job lease without marking anyone failed', async () => {
    mocks.send.mockReset().mockResolvedValue({ messageId: 'm' });
    const { db, updates } = recordingDb();
    let calls = 0;
    const assertLease = () => { if (++calls > 1) throw new Error('Job lease lost'); };
    await expect(deliverBroadcast(db, plan(['r1', 'r2', 'r3']), { ...options, assertLease })).rejects.toThrow('Job lease lost');
    expect(updates.map((u) => [u.id, u.row.status])).toEqual([['r1', 'sent']]);
  });

  it("fills a tracked template's link button with each recipient's own click token", async () => {
    mocks.send.mockReset().mockResolvedValue({ messageId: 'm' });
    const { db } = recordingDb();
    const templateRow = { buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }, { type: 'URL', text: 'Shop', url: `${appOrigin()}/r/{{1}}` }] } as MessageTemplate;
    const tracked = { ...plan(['r1', 'r2']), templateRow };
    tracked.planned[0].clickToken = 'a'.repeat(32);
    await deliverBroadcast(db, tracked, options);
    expect(mocks.send.mock.calls[0][0].messageParams).toEqual({ buttonParams: { 1: 'a'.repeat(32) } });
    // No token (e.g. created before tracking existed): nothing is filled in.
    expect(mocks.send.mock.calls[1][0].messageParams).toBeUndefined();
  });

  it('classifies only documented rate-limit codes and backs off up to 30 minutes', () => {
    expect([4, 80007, 130429, 131056].every((code) => isThrottled(new MetaApiError('x', { code, httpStatus: 400 })))).toBe(true);
    expect(isThrottled(new MetaApiError('x', { code: 131026, httpStatus: 400 }))).toBe(false);
    expect(isThrottled(new Error('130429'))).toBe(false);
    expect([1, 2, 3, 6, 10].map(throttleDelayMs)).toEqual([60_000, 120_000, 240_000, 1_800_000, 1_800_000]);
  });
});
