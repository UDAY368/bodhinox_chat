import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'agent', bulk: vi.fn(), importBatch: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/contacts/bulk', async () => {
  const { AudienceFilterError } = await import('@/lib/audience/filter');
  class BulkCountChangedError extends AudienceFilterError {
    constructor(readonly matched: number) {
      super('changed');
    }
  }
  return { BulkCountChangedError, bulkContactAction: h.bulk };
});
vi.mock('@/lib/contacts/import', () => ({ importContactBatch: h.importBatch }));

import { BulkCountChangedError } from '@/lib/contacts/bulk';
import { POST as bulk } from './route';
import { POST as importBatch } from '../import/route';

const post = (body: unknown) => new Request('http://localhost/api/contacts/bulk', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
});

it('refuses viewers before touching contacts', async () => {
  h.role = 'viewer';
  expect((await bulk(post({}))).status).toBe(403);
  expect((await importBatch(post({}))).status).toBe(403);
  expect(h.bulk).not.toHaveBeenCalled();
  expect(h.importBatch).not.toHaveBeenCalled();
});

it('runs as the live session tenant and returns 409 with the new count when the view changed', async () => {
  h.bulk.mockResolvedValueOnce({ matched: 3, changed: 3 });
  const ok = await bulk(post({ scope: {}, action: { type: 'delete' }, expected: 3 }));
  expect(await ok.json()).toEqual({ matched: 3, changed: 3 });
  expect(h.bulk).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, { scope: {}, action: { type: 'delete' }, expected: 3 });

  h.bulk.mockRejectedValueOnce(new BulkCountChangedError(5));
  const changed = await bulk(post({ scope: {}, action: { type: 'delete' }, expected: 3 }));
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ matched: 5 });
});
