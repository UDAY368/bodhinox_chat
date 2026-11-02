import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({
  role: 'admin',
  listForms: vi.fn(),
  createForm: vi.fn(),
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
  listForms: h.listForms,
  createForm: h.createForm,
}));

import { GET, POST } from './route';

const post = (body: unknown) => POST(new Request('http://localhost/api/whatsapp/forms', { method: 'POST', body: JSON.stringify(body) }));
const definition = {
  version: 1,
  screens: [{ id: 'S1', title: 'Hi', button_label: 'Send', fields: [{ id: 'name', type: 'short_text', label: 'Name' }] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.listForms.mockResolvedValue([{ id: 'f1', name: 'Lead', response_count: 2 }]);
  h.createForm.mockImplementation(async (_ctx, input) => ({ id: 'f2', ...input, status: 'draft' }));
});

describe('GET /api/whatsapp/forms', () => {
  it('lists forms to any member, scoped to the session tenant', async () => {
    h.role = 'viewer';
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forms: [{ id: 'f1', name: 'Lead', response_count: 2 }] });
    expect(h.listForms).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' });
  });
});

describe('POST /api/whatsapp/forms', () => {
  it('creates a draft for admins (201) with a normalised definition', async () => {
    const res = await post({ name: '  Lead form ', category: 'LEAD_GENERATION', definition });
    expect(res.status).toBe(201);
    const input = h.createForm.mock.calls[0][1];
    expect(input).toMatchObject({ name: 'Lead form', category: 'LEAD_GENERATION' });
    expect(input.definition.screens[0].id).toBe('S1');
  });

  it('leaves the definition to the default when none is sent', async () => {
    await post({ name: 'Lead', category: 'SURVEY' });
    expect(h.createForm.mock.calls[0][1].definition).toBeUndefined();
  });

  it('refuses agents and viewers before touching the database', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await post({ name: 'Lead', category: 'SURVEY' })).status).toBe(403);
    }
    expect(h.createForm).not.toHaveBeenCalled();
  });

  it('rejects a bad name or category (400) and a bad definition (422 with paths)', async () => {
    expect((await post({ name: '', category: 'SURVEY' })).status).toBe(400);
    expect((await post({ name: 'x'.repeat(201), category: 'SURVEY' })).status).toBe(400);
    expect((await post({ name: 'Lead', category: 'MARKETING' })).status).toBe(400);
    expect((await post({ name: 'Lead', category: 'SURVEY', uses_endpoint: 'yes' })).status).toBe(400);
    const res = await post({ name: 'Lead', category: 'SURVEY', definition: { version: 1, screens: [] } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toHaveProperty('path');
    expect(h.createForm).not.toHaveBeenCalled();
  });

  it('turns a duplicate name into 409', async () => {
    const { FormServiceError } = await import('@/lib/whatsapp/forms/service');
    h.createForm.mockRejectedValueOnce(new FormServiceError(409, 'taken'));
    expect((await post({ name: 'Lead', category: 'SURVEY' })).status).toBe(409);
  });

  it('does not leak unexpected errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.createForm.mockRejectedValueOnce(new Error('relation secret_table does not exist'));
    const res = await post({ name: 'Lead', category: 'SURVEY' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret_table');
  });
});
