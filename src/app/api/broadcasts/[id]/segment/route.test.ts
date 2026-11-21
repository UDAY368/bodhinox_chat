import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudienceFilterError, AudienceNotFoundError } from '@/lib/audience/filter';

const ID = '22222222-2222-4222-8222-22222222222b';
const h = vi.hoisted(() => ({
  roleDenied: false,
  calls: [] as unknown[][],
  result: { id: 'seg-1', name: 'Sale – Failed', filter: {}, secret: 'never' } as unknown,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async (minimum: string) => {
    if (h.roleDenied) throw Object.assign(new Error('Insufficient workspace role'), { status: 403 });
    expect(minimum).toBe('agent');
    return { accountId: 'acct', userId: 'u-1', role: 'agent' };
  },
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/broadcasts/result-segment', () => ({
  createResultSegment: async (...args: unknown[]) => {
    h.calls.push(args);
    if (h.result instanceof Error) throw h.result;
    return h.result;
  },
}));

import { POST } from './route';

const post = (body: unknown, id = ID) => POST(new Request(`http://localhost/api/broadcasts/${id}/segment`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) });

describe('POST /api/broadcasts/[id]/segment', () => {
  beforeEach(() => { h.roleDenied = false; h.calls = []; h.result = { id: 'seg-1', name: 'Sale – Failed', filter: {}, secret: 'never' }; });

  it('refuses a viewer before touching segments', async () => {
    h.roleDenied = true;
    expect((await post({ result: 'failed' })).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('creates the segment in the caller tenant and answers only its id and name', async () => {
    const res = await post({ result: 'failed' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ segment: { id: 'seg-1', name: 'Sale – Failed' } });
    expect(h.calls).toEqual([[{ accountId: 'acct', userId: 'u-1', role: 'agent' }, ID, 'failed']]);
  });

  it('maps another workspace campaign to 404 and a bad result to 400; a malformed id never reaches the database', async () => {
    h.result = new AudienceNotFoundError('Campaign unavailable');
    expect((await post({ result: 'failed' })).status).toBe(404);
    h.result = new AudienceFilterError('Choose a campaign result');
    expect((await post({ result: 'everyone' })).status).toBe(400);
    h.calls = [];
    expect((await post({ result: 'failed' }, 'nope')).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});
