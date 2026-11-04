import { beforeEach, expect, it, vi } from 'vitest';
import { buildQuery } from '@/lib/data/builder';
import type { QuerySpec, Row } from '@/lib/data/types';

const h = vi.hoisted(() => ({
  accountId: 'account-a',
  role: 'agent',
  flows: [] as Row[],
  nodes: [] as Row[],
  writes: [] as QuerySpec[],
  secrets: new Set<string>(),
  failNodeInsert: false,
}));
vi.mock('@/lib/workspace/attributes', () => ({ secretAttributeKeys: async () => h.secrets }));
vi.mock('@/lib/data/server', () => ({ createClient: async () => db() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ db: db(), accountId: 'account-a', userId: 'copier', role: h.role }),
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));

let nextId = 0;
function db() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'copier' } }, error: null }) },
    from: (table: string) =>
      buildQuery(table, async (spec) => {
        const source = table === 'flows' ? h.flows : h.nodes;
        // RLS: the caller sees only its own account's rows.
        const matches = (row: Row) => row.account_id === h.accountId && spec.filters.every((f) => row[f.field] === f.value);
        if (spec.operation === 'insert') {
          h.writes.push(spec);
          if (table === 'flow_nodes' && h.failNodeInsert) return { data: null, error: { message: 'node insert failed' } };
          const values = (Array.isArray(spec.values) ? spec.values : [spec.values!]).map((row) => ({
            id: table === 'flows' ? `copy-${++nextId}` : undefined, ...row, account_id: h.accountId,
          }));
          source.push(...values);
          return { data: spec.cardinality ? values[0] : values, error: null };
        }
        const found = source.filter(matches);
        if (spec.operation === 'delete') {
          h.writes.push(spec);
          const remaining = source.filter((row) => !matches(row));
          if (table === 'flows') h.flows = remaining;
          else h.nodes = remaining;
        }
        return { data: spec.cardinality ? (found[0] ?? null) : found, error: null };
      }),
  };
}
import { POST } from './route';
import { getT } from '@/lib/i18n/translate';

// Translated, so read it the same way the route does ("Copy of Welcome" in English).
const copyName = getT('Api')('flows.copyName', { name: 'Welcome' });

const duplicate = () => POST(new Request('http://localhost/', { method: 'POST' }), { params: Promise.resolve({ id: 'flow-a' }) });
const apiNode = { flow_id: 'flow-a', account_id: 'account-a', node_key: 'call', node_type: 'api_request', position_x: 5, position_y: 6,
  config: { method: 'GET', url: 'https://api.example.com/', headers: [{ key: 'Authorization', value: 'Bearer {{workspace.api_key}}' }] } };

beforeEach(() => {
  h.accountId = 'account-a';
  h.role = 'agent';
  h.writes = [];
  h.secrets = new Set();
  h.failNodeInsert = false;
  h.flows = [{
    id: 'flow-a', account_id: 'account-a', user_id: 'author', name: 'Welcome', description: 'Greets people', status: 'active',
    trigger_type: 'keyword', trigger_config: { keywords: ['hi'] }, entry_node_id: 'start', fallback_policy: { mode: 'end' },
    test_numbers: ['919876543210'], execution_count: 42,
  }];
  h.nodes = [
    { flow_id: 'flow-a', account_id: 'account-a', node_key: 'start', node_type: 'start', config: { next_node_key: 'done' }, position_x: 1, position_y: 2 },
    { flow_id: 'flow-a', account_id: 'account-a', node_key: 'done', node_type: 'end', config: {}, position_x: 3, position_y: 4 },
  ];
});

it('copies the flow and every node into a new draft owned by the caller', async () => {
  const response = await duplicate();
  expect(response.status).toBe(201);
  const { flow } = await response.json();
  expect(copyName).not.toBe('Welcome');
  expect(flow).toMatchObject({
    user_id: 'copier', name: copyName, description: 'Greets people', status: 'draft', trigger_type: 'keyword',
    trigger_config: { keywords: ['hi'] }, entry_node_id: 'start', fallback_policy: { mode: 'end' }, test_numbers: [],
    channel_scope: 'whatsapp',
  });
  expect(flow.execution_count).toBeUndefined();
  expect(h.nodes.filter((n) => n.flow_id === flow.id).map(({ node_key, node_type, config, position_x, position_y }) =>
    ({ node_key, node_type, config, position_x, position_y }))).toEqual([
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'done' }, position_x: 1, position_y: 2 },
    { node_key: 'done', node_type: 'end', config: {}, position_x: 3, position_y: 4 },
  ]);
  // The source is untouched.
  expect(h.flows[0]).toMatchObject({ id: 'flow-a', status: 'active', test_numbers: ['919876543210'] });
});

it('keeps the source flow channel scope on the copy', async () => {
  h.flows[0].channel_scope = 'instagram';
  const response = await duplicate();
  expect(response.status).toBe(201);
  expect((await response.json()).flow.channel_scope).toBe('instagram');
});

it("returns 404 for another account's flow without writing anything", async () => {
  h.accountId = 'account-b';
  expect((await duplicate()).status).toBe(404);
  expect(h.writes).toEqual([]);
});

it("refuses an agent copying an API step that uses a secret, but lets an admin", async () => {
  h.secrets = new Set(['api_key']);
  h.nodes.push(apiNode);
  const refused = await duplicate();
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toMatch(/admin/i);
  expect(h.writes).toEqual([]);

  h.role = 'admin';
  expect((await duplicate()).status).toBe(201);
});

it('lets an agent copy an API step that uses no secret value', async () => {
  h.secrets = new Set(['other_key']);
  h.nodes.push(apiNode);
  expect((await duplicate()).status).toBe(201);
});

it('deletes the new flow when inserting its nodes fails', async () => {
  h.failNodeInsert = true;
  const response = await duplicate();
  expect(response.status).toBe(500);
  expect(h.flows.map((f) => f.id)).toEqual(['flow-a']);
  expect(h.writes.map((w) => `${w.resource}:${w.operation}`)).toEqual(['flows:insert', 'flow_nodes:insert', 'flows:delete']);
});
