// POST /api/contacts/{id}/erase: session, Origin/CSRF proof, admin role, rate limit,
// then the queued request; fixed codes for refusals.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ role: 'admin', signedIn: true, mutationOk: true, calls: [] as unknown[][], fail: null as unknown }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).ForbiddenError('Invalid origin');
  },
}));
vi.mock('@/lib/privacy/contact-erasure', async (original) => ({
  ...(await original<typeof import('@/lib/privacy/contact-erasure')>()),
  requestContactErasure: async (...args: unknown[]) => {
    if (h.fail) throw h.fail;
    h.calls.push(args);
  },
}));

import { ContactErasureError } from '@/lib/privacy/contact-erasure';
import { POST } from './route';

const call = () => POST(new Request(`http://localhost/api/contacts/${CONTACT}/erase`, { method: 'POST' }),
  { params: Promise.resolve({ id: CONTACT }) });

beforeEach(() => {
  h.role = 'admin';
  h.signedIn = true;
  h.mutationOk = true;
  h.calls = [];
  h.fail = null;
});

describe('POST /api/contacts/[id]/erase', () => {
  it('queues the erasure for an admin in their own workspace', async () => {
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect(h.calls).toEqual([[{ accountId: ACCOUNT, userId: USER, role: 'admin' }, CONTACT]]);
  });

  it('refuses agents and viewers, a missing session and a failed CSRF check before queuing anything', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await call()).status).toBe(403);
    }
    h.role = 'owner';
    h.mutationOk = false;
    expect((await call()).status).toBe(403);
    h.mutationOk = true;
    h.signedIn = false;
    expect((await call()).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('answers a fixed code when the contact is not in this workspace', async () => {
    h.fail = new ContactErasureError('not_found', 404);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
  });
});
