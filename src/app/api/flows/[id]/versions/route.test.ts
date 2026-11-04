import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  account: 'account-a',
  versions: [] as Array<Record<string, unknown>>,
  roleError: null as Error | null,
}));

class Unauthorized extends Error {
  status = 401;
}
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => {
    if (h.roleError) throw h.roleError;
    return { accountId: h.account, userId: 'viewer-1', role: 'viewer' };
  },
  toErrorResponse: (err: unknown) => Response.json({ error: 'x' }, { status: err instanceof Unauthorized ? 401 : 500 }),
}));
vi.mock('@/lib/auth/session', () => ({ requireSession: vi.fn(), assertMutation: vi.fn() }));
vi.mock('@/lib/audience/http', () => ({ tenantOf: (c: unknown) => c }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/flows/versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/versions')>()),
  // RLS: rows of another account are invisible.
  readVersion: async (_tx: unknown, accountId: string, id: string) =>
    h.versions.find((v) => v.id === id && v.account_id === accountId) ?? null,
  readPublishState: async (_tx: unknown, accountId: string, flowId: string) =>
    accountId === 'account-a' && flowId === FLOW ? { published_version: { id: V1, version: 1 }, draft_hash: 'd', has_unpublished_changes: false } : null,
  listVersions: async () => [{ id: V1, version: 1, published_at: '2026-11-01T00:00:00.000Z', published_by_name: 'A', node_count: 2, active_runs: 1 }],
  // Two more runs in progress are on no version (draft test-number runs).
  countActiveRuns: async () => 3,
}));

import { GET as list } from './route';
import { GET as one } from './[versionId]/route';

const FLOW = '11111111-1111-4111-8111-111111111111';
const OTHER_FLOW = '22222222-2222-4222-8222-222222222222';
const V1 = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  h.account = 'account-a';
  h.roleError = null;
  h.versions = [{ id: V1, account_id: 'account-a', flow_id: FLOW, version: 1, published_at: '2026-11-01T00:00:00.000Z', trigger_type: 'manual',
    trigger_config: {}, entry_node_id: 'start', fallback_policy: {}, channel_scope: 'whatsapp', published_by: 'secret-user',
    nodes: [{ node_key: 'start', node_type: 'start', config: {} }] }];
});

it('lists versions with the publish state for any member, uncached', async () => {
  const res = await list(new Request('http://localhost/'), { params: Promise.resolve({ id: FLOW }) });
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await res.json()).toMatchObject({ versions: [{ version: 1, active_runs: 1 }], published_version: { version: 1 } });
});

it('reports every run in progress on the flow, including runs on no version, for the archive dialog', async () => {
  const res = await list(new Request('http://localhost/'), { params: Promise.resolve({ id: FLOW }) });
  expect(await res.json()).toMatchObject({ active_runs: 3, versions: [{ active_runs: 1 }] });
});

it('answers 404 for a flow of another workspace and 401 without a session', async () => {
  h.account = 'account-b';
  expect((await list(new Request('http://localhost/'), { params: Promise.resolve({ id: FLOW }) })).status).toBe(404);
  h.roleError = new Unauthorized();
  expect((await list(new Request('http://localhost/'), { params: Promise.resolve({ id: FLOW }) })).status).toBe(401);
});

it('returns one snapshot, and 404 for another workspace, another flow or a malformed id', async () => {
  const get = (id: string, versionId: string) => one(new Request('http://localhost/'), { params: Promise.resolve({ id, versionId }) });
  const res = await get(FLOW, V1);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.version).toMatchObject({ version: 1, nodes: [{ node_key: 'start' }] });
  // Only the snapshot is exposed, not who published it.
  expect(body.version.published_by).toBeUndefined();
  expect((await get(OTHER_FLOW, V1)).status).toBe(404);
  expect((await get(FLOW, 'nope')).status).toBe(404);
  h.account = 'account-b';
  expect((await get(FLOW, V1)).status).toBe(404);
});
