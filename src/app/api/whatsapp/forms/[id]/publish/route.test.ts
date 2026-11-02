import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FORM = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', limited: false, publishForm: vi.fn() }));

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
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/whatsapp/forms/service', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/forms/service')>()),
  publishForm: h.publishForm,
}));

import { FormServiceError } from '@/lib/whatsapp/forms/service';
import { POST } from './route';

const publish = () => POST(new Request('http://localhost/p', { method: 'POST' }), { params: Promise.resolve({ id: FORM }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.limited = false;
  h.publishForm.mockResolvedValue({ id: FORM, status: 'published' });
});

it('publishes for admins', async () => {
  const res = await publish();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ form: { id: FORM, status: 'published' } });
  expect(h.publishForm).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, FORM);
});

it('refuses agents and is rate limited', async () => {
  h.role = 'agent';
  expect((await publish()).status).toBe(403);
  h.role = 'admin';
  h.limited = true;
  expect((await publish()).status).toBe(429);
  expect(h.publishForm).not.toHaveBeenCalled();
});

it('returns Meta validation errors as 422 { error, errors }', async () => {
  h.publishForm.mockRejectedValueOnce(new FormServiceError(422, 'Meta rejected it', [{ error: 'INVALID', message: 'bad' }]));
  const res = await publish();
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({ error: 'Meta rejected it', errors: [{ error: 'INVALID', message: 'bad' }] });
});

it('passes 409 (not connected) and 502 (Meta down) through', async () => {
  h.publishForm.mockRejectedValueOnce(new FormServiceError(409, 'connect first'));
  expect((await publish()).status).toBe(409);
  h.publishForm.mockRejectedValueOnce(new FormServiceError(502, 'Meta down'));
  expect((await publish()).status).toBe(502);
});
