import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'agent', mask: false, exportCsv: vi.fn() }));

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
vi.mock('@/lib/audience/export', () => ({ exportContactsCsv: h.exportCsv }));
vi.mock('@/lib/inbox/masking-apply', () => ({ resolvePhoneMask: async () => h.mask }));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  h.mask = false;
  h.exportCsv.mockResolvedValue({ csv: 'name,phone\nAsha,+919876543210\n' });
});

it('refuses agents and viewers, the only members whose numbers can be masked', async () => {
  for (const role of ['agent', 'viewer']) {
    h.role = role;
    const res = await GET(new Request('http://localhost/api/contacts/export'));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('9876543210');
  }
  expect(h.exportCsv).not.toHaveBeenCalled();
});

it('refuses a masked caller even if export were opened to it', async () => {
  h.role = 'admin';
  h.mask = true;
  const res = await GET(new Request('http://localhost/api/contacts/export'));
  expect(res.status).toBe(403);
  expect(h.exportCsv).not.toHaveBeenCalled();
});

it('exports for an admin', async () => {
  h.role = 'admin';
  const res = await GET(new Request('http://localhost/api/contacts/export'));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('+919876543210');
});
