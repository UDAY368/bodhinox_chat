import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FORM = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', duplicateForm: vi.fn() }));

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
  duplicateForm: h.duplicateForm,
}));

import { FormServiceError, duplicateFormName } from '@/lib/whatsapp/forms/service';
import { POST } from './route';

const duplicate = () => POST(new Request('http://localhost/d', { method: 'POST' }), { params: Promise.resolve({ id: FORM }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.duplicateForm.mockResolvedValue({ id: 'copy', name: 'Lead (copy)', status: 'draft', meta_flow_id: null });
});

it('creates the copy for admins (201)', async () => {
  const res = await duplicate();
  expect(res.status).toBe(201);
  expect((await res.json()).form.name).toBe('Lead (copy)');
});

it('refuses agents and 404s another account', async () => {
  h.role = 'agent';
  expect((await duplicate()).status).toBe(403);
  h.role = 'admin';
  h.duplicateForm.mockRejectedValueOnce(new FormServiceError(404, 'nope'));
  expect((await duplicate()).status).toBe(404);
});

it('names copies uniquely within the length limit', () => {
  expect(duplicateFormName('Lead', new Set())).toBe('Lead (copy)');
  expect(duplicateFormName('Lead', new Set(['Lead (copy)', 'Lead (copy 2)']))).toBe('Lead (copy 3)');
  const long = duplicateFormName('x'.repeat(200), new Set());
  expect(long).toHaveLength(200);
  expect(long?.endsWith(' (copy)')).toBe(true);
});
