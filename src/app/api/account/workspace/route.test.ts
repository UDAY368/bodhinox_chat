import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', sql: [] as string[], values: [] as unknown[][] }));

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
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.sql.push(strings.join('?'));
      h.values.push(values);
      return [{ name: 'Acme Ltd', default_language: 'es' }];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { h.sql.push(strings.join('?')); h.values.push(values); return 1; },
  }),
}));

import { GET, PUT } from './route';
import { parseWorkspaceUpdate, WorkspaceSettingsError } from '@/lib/settings/workspace-settings';

const put = (body: unknown) => new Request('http://x/api/account/workspace', { method: 'PUT', body: JSON.stringify(body) });

beforeEach(() => {
  h.role = 'admin';
  h.sql = [];
  h.values = [];
});

it('lets any member read the name and default language, saying whether they can edit', async () => {
  h.role = 'viewer';
  const res = await GET();
  expect(await res.json()).toEqual({ workspace: { name: 'Acme Ltd', default_language: 'es' }, can_edit: false });
});

it.each(['agent', 'viewer'])('refuses a %s save without writing', async (role) => {
  h.role = role;
  expect((await PUT(put({ name: 'New' }))).status).toBe(403);
  expect(h.sql).toEqual([]);
});

it('saves for an admin, scoped to the session workspace, and audits field names only', async () => {
  const res = await PUT(put({ name: '  Acme Ltd  ', default_language: 'es' }));
  expect(res.status).toBe(200);
  expect(h.sql[0]).toContain('UPDATE accounts');
  expect(h.values[0]).toContain(ACCOUNT);
  expect(h.values[0]).toContain('Acme Ltd');
  expect(h.sql[1]).toContain('INSERT INTO audit_logs');
  expect(JSON.stringify(h.values[1])).not.toContain('Acme Ltd');
});

it('rejects invalid bodies', async () => {
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(81) }, { default_language: 'fr' }, { name: 'A', account_id: ACCOUNT }])
    expect((await PUT(put(body))).status, JSON.stringify(body)).toBe(400);
  expect(h.sql).toEqual([]);
});

it('parses updates strictly', () => {
  expect(parseWorkspaceUpdate({ default_language: null })).toEqual({ default_language: null });
  expect(() => parseWorkspaceUpdate([])).toThrow(WorkspaceSettingsError);
});
