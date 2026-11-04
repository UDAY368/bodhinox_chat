import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mutation: vi.fn(async () => {}),
  role: vi.fn(async () => ({ accountId: 'account-a', userId: 'u-1', role: 'agent' })),
  run: vi.fn(),
  audit: vi.fn(async () => 1),
  user: 'u-1',
}));

class Forbidden extends Error {
  status = 403;
}
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ accountId: 'account-a', userId: h.user, role: 'agent', sessionId: 's' }),
  assertMutation: h.mutation,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.role,
  toErrorResponse: (err: unknown) => Response.json({ error: 'x' }, { status: err instanceof Forbidden ? 403 : 500 }),
}));
vi.mock('@/lib/audience/http', () => ({ tenantOf: (c: unknown) => c }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({ $executeRaw: h.audit }) }));
vi.mock('@/lib/flows/dry-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/dry-run')>()),
  runDryRun: h.run,
}));

import { DryRunError } from '@/lib/flows/dry-run';
import { POST } from './route';

const FLOW = '11111111-1111-4111-8111-111111111111';
const ctx = (id = FLOW) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) => new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) });
const RESULT = { trace: [{ id: 0, from: 'bot', text: 'Hi' }], waiting: null, ended: true, applied: 0, rejected_input: null,
  notes: [], issues: [], version: 2, contact: null };

let n = 0;
beforeEach(() => {
  h.user = `u-${++n}`;
  h.role.mockResolvedValue({ accountId: 'account-a', userId: h.user, role: 'agent' });
  for (const fn of [h.mutation, h.run, h.audit]) fn.mockReset();
  h.run.mockResolvedValue(RESULT);
  h.audit.mockResolvedValue(1);
});

it('runs the dry run for an agent behind CSRF and audits it without content', async () => {
  const res = await POST(req({ source: 'published', inputs: [{ option_id: 'yes' }] }), ctx());
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await res.json()).toEqual(RESULT);
  expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-a' }), FLOW,
    { source: 'published', contactId: undefined, inputs: [{ option_id: 'yes' }], apiPorts: {} });
  expect(h.audit).toHaveBeenCalledTimes(1);
  const sql = h.audit.mock.calls[0] as unknown as [{ sql: string; values: unknown[] }];
  expect(sql[0].sql).toContain("'flows.dry_run'");
  expect(JSON.stringify(sql[0].values)).not.toContain('Hi');
});

it('refuses without CSRF or role, before doing anything', async () => {
  h.mutation.mockRejectedValueOnce(new Forbidden());
  expect((await POST(req({}), ctx())).status).toBe(403);
  h.role.mockRejectedValueOnce(new Forbidden());
  expect((await POST(req({}), ctx())).status).toBe(403);
  expect(h.run).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
});

it('validates the id and body and maps missing or unpublished sources', async () => {
  expect((await POST(req({}), ctx('nope'))).status).toBe(404);
  expect((await POST(req({ source: 'v2' }), ctx())).status).toBe(400);
  h.run.mockRejectedValueOnce(new DryRunError('not_found'));
  expect((await POST(req({}), ctx())).status).toBe(404);
  h.run.mockRejectedValueOnce(new DryRunError('not_published'));
  expect((await POST(req({ source: 'published' }), ctx())).status).toBe(409);
  h.run.mockRejectedValueOnce(new Error('boom: secret detail'));
  const failed = await POST(req({}), ctx());
  expect(failed.status).toBe(500);
  expect(JSON.stringify(await failed.json())).not.toContain('secret detail');
  expect(h.audit).not.toHaveBeenCalled();
});

it('rate-limits dry runs per member', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 21; i += 1) codes.push((await POST(req({}), ctx())).status);
  expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
  expect(codes[20]).toBe(429);
});
