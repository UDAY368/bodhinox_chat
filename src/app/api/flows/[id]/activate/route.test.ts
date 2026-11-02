import { beforeEach, expect, it, vi } from 'vitest';
import { buildQuery } from '@/lib/data/builder';
import type { QuerySpec, Row } from '@/lib/data/types';

const h = vi.hoisted(() => ({
  flows: [] as Row[],
  nodes: [] as Row[],
  writes: [] as QuerySpec[],
  limit: vi.fn(async () => {}),
}));

function db() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'author' } }, error: null }) },
    from: (table: string) =>
      buildQuery(table, async (spec) => {
        const source = table === 'flows' ? h.flows : h.nodes;
        const found = source.filter((row) => spec.filters.every((f) => row[f.field] === f.value));
        if (spec.operation === 'update') {
          h.writes.push(spec);
          for (const row of found) Object.assign(row, spec.values);
        }
        return { data: spec.cardinality ? (found[0] ?? null) : found, error: null };
      }),
  };
}
vi.mock('@/lib/data/server', () => ({ createClient: async () => db() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'account-a', userId: 'author', role: 'agent' }),
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({ $queryRaw: async () => [{ n: 0 }] }) }));
vi.mock('@/lib/audience/http', () => ({ tenantOf: () => ({}) }));
vi.mock('@/lib/billing/entitlements', () => ({ requireWithinLimit: h.limit }));

// Feature permissions are covered in src/lib/auth/permissions.test.ts; allowed here.
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: async () => undefined }));
import { POST } from './route';

const context = { params: Promise.resolve({ id: 'flow-a' }) };
const move = (status: string) => POST(new Request('http://localhost/', { method: 'POST', body: JSON.stringify({ status }) }), context);
const validNodes = [
  { flow_id: 'flow-a', node_key: 'start', node_type: 'start', config: { next_node_key: 'done' } },
  { flow_id: 'flow-a', node_key: 'done', node_type: 'end', config: {} },
];

beforeEach(() => {
  h.flows = [{ id: 'flow-a', name: 'F', status: 'archived', trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', fallback_policy: {}, test_numbers: ['919876543210'] }];
  h.nodes = [{ flow_id: 'flow-a', node_key: 'start', node_type: 'start', config: { next_node_key: '' } }];
  h.writes = [];
  h.limit.mockReset();
});

it('validates and counts a flow moved to draft while it still has test numbers', async () => {
  expect((await move('draft')).status).toBe(422);
  expect(h.writes).toEqual([]);
  h.nodes = validNodes;
  expect((await move('draft')).status).toBe(200);
  expect(h.limit).toHaveBeenCalledWith(expect.anything(), 'account-a', 'active_flows', 1);
  expect(h.flows[0]).toMatchObject({ status: 'draft', test_numbers: ['919876543210'] });
});

it('clears test numbers when the flow goes live, so pausing it gives a plain draft', async () => {
  h.nodes = validNodes;
  expect((await move('active')).status).toBe(200);
  expect(h.flows[0]).toMatchObject({ status: 'active', test_numbers: [] });
  h.limit.mockClear();
  expect((await move('draft')).status).toBe(200);
  expect(h.limit).not.toHaveBeenCalled();
});

it('archives without validation', async () => {
  h.flows[0].status = 'active';
  expect((await move('archived')).status).toBe(200);
  expect(h.limit).not.toHaveBeenCalled();
});
