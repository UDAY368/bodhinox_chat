import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/auth/client', async (original) => ({
  ...(await original<typeof import('@/lib/auth/client')>()),
  authFetch: (...args: unknown[]) => h.fetch(...args),
}));

import { sequenceApi, sequenceErrorKey, SequenceRequestError } from './sequence-api';

const SEQ = '33333333-3333-4333-8333-333333333333';
const respond = (status: number, body: unknown) => h.fetch.mockResolvedValueOnce(Response.json(body, { status }));

beforeEach(() => h.fetch.mockReset());

describe('sequence client', () => {
  it('sends JSON writes to the fixed routes through the authenticated fetch', async () => {
    respond(201, { sequence: { id: SEQ } });
    await sequenceApi.addNew(SEQ, 'Day one');
    const [path, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/sequences/${SEQ}/messages`);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(String(init.body))).toEqual({ create: { name: 'Day one' } });

    respond(200, { status: 'unsubscribed' });
    expect(await sequenceApi.unsubscribe(SEQ, 'c1')).toBe('unsubscribed');
    expect(JSON.parse(String((h.fetch.mock.calls[1][1] as RequestInit).body))).toEqual({ action: 'unsubscribe', contact_id: 'c1' });
  });

  it('turns a refusal into a known error code, and anything else into generic', async () => {
    respond(409, { error: 'busy', code: 'busy' });
    const busy = await sequenceApi.removeMessage(SEQ, 'm1').catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(SequenceRequestError);
    expect(sequenceErrorKey(busy)).toBe('busy');

    respond(500, { code: 'internal detail' });
    expect(sequenceErrorKey(await sequenceApi.list().catch((e: unknown) => e))).toBe('generic');
    h.fetch.mockResolvedValueOnce(new Response('not json', { status: 502 }));
    expect(sequenceErrorKey(await sequenceApi.get(SEQ).catch((e: unknown) => e))).toBe('generic');
    expect(sequenceErrorKey(new Error('network'))).toBe('generic');
  });
});
