// "Retry failed" and uncertain sends in deliverBroadcast (audit 2026-11-10, findings 11 and 12).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';

const h = vi.hoisted(() => {
  class UncertainDispatchError extends Error {}
  // outbound_intents by key, modelled like dispatchOnce: an accepted intent replays its stored result.
  const intents = new Map<string, { status: string; result?: unknown }>();
  return { UncertainDispatchError, intents, send: vi.fn() };
});
vi.mock('./meta-api', async (original) => ({ ...(await original<typeof import('./meta-api')>()), sendTemplateMessage: h.send }));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: async (_a: string, url: string) => url }));
vi.mock('@/lib/jobs/dispatch', () => ({
  UncertainDispatchError: h.UncertainDispatchError,
  dispatchOnce: async (_account: string, key: string, send: () => Promise<unknown>) => {
    const existing = h.intents.get(key);
    if (existing?.status === 'accepted') return existing.result;
    if (existing) throw new h.UncertainDispatchError();
    h.intents.set(key, { status: 'dispatching' });
    try {
      const result = await send();
      h.intents.set(key, { status: 'accepted', result });
      return result;
    } catch (error) {
      const status = (error as { httpStatus?: number }).httpStatus ?? 0;
      const rejected = status >= 400 && status < 500;
      h.intents.set(key, { status: rejected ? 'failed' : 'unknown' });
      if (rejected) throw error;
      throw new h.UncertainDispatchError();
    }
  },
}));
import { broadcastIntentKey, deliverBroadcast, UNCERTAIN_SEND_MESSAGE } from './broadcast-core';

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
  return { db: { from: () => chain } as unknown as DataClient, updates: () => updates.filter((u) => u.id !== 'b') };
}

const PHONE = '12025550000';
const plan = (recipient: Record<string, unknown>) => ({
  broadcastId: 'b', templateName: 't', templateLanguage: 'en', phoneNumberId: 'pn', accessToken: 'x', templateRow: null, rejected: 0,
  planned: [{ recipientRowId: 'r1', phone: PHONE, params: [] as string[], clickToken: null, ...recipient }],
});
const options = { accountId: 'acct', assertLease: () => {}, attemptId: 'job', retryRejected: true };

describe('Retry failed after Meta accepted and later failed a message (finding 11)', () => {
  beforeEach(() => {
    h.intents.clear();
    h.send.mockReset();
    // The first send: Meta accepted it, then a status webhook failed the row.
    h.intents.set(broadcastIntentKey('b', 'r1', PHONE), { status: 'accepted', result: { messageId: 'wamid.OLD' } });
  });

  it('never marks the row sent by replaying the old accepted intent', async () => {
    const { db, updates } = recordingDb();
    const result = await deliverBroadcast(db, plan({ previousMessageId: 'wamid.OLD' }), options);
    expect(h.send).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    // Meta's failure stays on the row.
    expect(updates()).toEqual([]);
  });

  it('sends once more under the next retry generation and records the new message', async () => {
    h.send.mockResolvedValue({ messageId: 'wamid.NEW' });
    const { db, updates } = recordingDb();
    const result = await deliverBroadcast(db, plan({ retryGeneration: 1 }), options);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    expect(updates()).toEqual([{ id: 'r1', row: expect.objectContaining({ status: 'sent', whatsapp_message_id: 'wamid.NEW', outcome_uncertain_at: null }) }]);
    expect(h.intents.get(broadcastIntentKey('b', 'r1', PHONE, 1))).toMatchObject({ status: 'accepted' });

    // A second pass of the same generation (requeued job) replays it and sends nothing new.
    await deliverBroadcast(recordingDb().db, plan({ retryGeneration: 1 }), options);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('keeps generation 0 on the original intent key', () => {
    expect(broadcastIntentKey('b', 'r1', PHONE)).toBe(`broadcast:b:r1:${PHONE}`);
    expect(broadcastIntentKey('b', 'r1', PHONE, 2)).toBe(`broadcast:b:r1:${PHONE}:retry2`);
  });
});

describe('uncertain sends (finding 12)', () => {
  beforeEach(() => { h.intents.clear(); h.send.mockReset(); });

  it('fails the row and flags it uncertain, so Retry failed leaves it for staff', async () => {
    h.send.mockRejectedValue(new Error('socket hang up'));
    const { db, updates } = recordingDb();
    await deliverBroadcast(db, plan({}), options);
    const last = updates().at(-1);
    expect(last?.row).toMatchObject({ status: 'failed', error_message: UNCERTAIN_SEND_MESSAGE, outcome_uncertain_at: expect.any(String) });
  });

  it('does not flag an ordinary refusal as uncertain', async () => {
    const { MetaApiError } = await import('./meta-api');
    h.send.mockRejectedValue(new MetaApiError('Template does not exist', { code: 132001, httpStatus: 404 }));
    const { db, updates } = recordingDb();
    await deliverBroadcast(db, plan({}), options);
    expect(updates().at(-1)?.row).toMatchObject({ status: 'failed', outcome_uncertain_at: null });
  });
});
