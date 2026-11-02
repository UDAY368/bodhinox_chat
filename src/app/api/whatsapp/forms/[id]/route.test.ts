import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FORM = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'admin',
  getForm: vi.fn(),
  updateForm: vi.fn(),
  deleteForm: vi.fn(),
}));

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
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/whatsapp/forms/service', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/forms/service')>()),
  getForm: h.getForm,
  updateForm: h.updateForm,
  deleteForm: h.deleteForm,
}));

import { FormServiceError } from '@/lib/whatsapp/forms/service';
import { DELETE, GET, PUT } from './route';

const params = (id = FORM) => ({ params: Promise.resolve({ id }) });
const put = (body: unknown) => PUT(new Request('http://localhost/f', { method: 'PUT', body: JSON.stringify(body) }), params());
const del = () => DELETE(new Request('http://localhost/f', { method: 'DELETE' }), params());

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.getForm.mockResolvedValue({ id: FORM, name: 'Lead' });
  h.updateForm.mockImplementation(async (_ctx, _id, input) => ({ id: FORM, ...input }));
  h.deleteForm.mockResolvedValue(undefined);
});

describe('GET /api/whatsapp/forms/[id]', () => {
  it('returns the form to any member', async () => {
    h.role = 'viewer';
    const res = await GET(new Request('http://localhost/f'), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ form: { id: FORM, name: 'Lead' } });
    expect(h.getForm).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' }, FORM);
  });

  it('is a 404 for another account (the service finds nothing)', async () => {
    h.getForm.mockRejectedValueOnce(new FormServiceError(404, 'not found'));
    expect((await GET(new Request('http://localhost/f'), params())).status).toBe(404);
  });
});

describe('PUT /api/whatsapp/forms/[id]', () => {
  it('saves a partial edit for admins', async () => {
    const res = await put({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(h.updateForm.mock.calls[0][2]).toEqual({ name: 'Renamed' });
  });

  it('refuses agents and viewers', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await put({ name: 'x' })).status).toBe(403);
    }
    expect(h.updateForm).not.toHaveBeenCalled();
  });

  it('returns 422 with paths for an invalid definition', async () => {
    const res = await put({ definition: { version: 1, screens: [{ id: 'bad id', title: '', fields: [], button_label: '' }] } });
    expect(res.status).toBe(422);
    const { errors } = await res.json();
    expect(errors.map((e: { path: string }) => e.path)).toContain('screens.0.id');
    expect(h.updateForm).not.toHaveBeenCalled();
  });

  it('passes the published-form lock through as 409', async () => {
    h.updateForm.mockRejectedValueOnce(new FormServiceError(409, 'duplicate it'));
    const res = await put({ name: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'duplicate it' });
  });
});

describe('DELETE /api/whatsapp/forms/[id]', () => {
  it('deletes for admins', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(h.deleteForm).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, FORM);
  });

  it('refuses agents', async () => {
    h.role = 'agent';
    expect((await del()).status).toBe(403);
    expect(h.deleteForm).not.toHaveBeenCalled();
  });

  it('reports a Meta failure as 502', async () => {
    h.deleteForm.mockRejectedValueOnce(new FormServiceError(502, 'Meta said no'));
    expect((await del()).status).toBe(502);
  });
});
