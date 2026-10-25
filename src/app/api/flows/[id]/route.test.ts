import { beforeEach, expect, it, vi } from 'vitest';
import { buildQuery } from '@/lib/data/builder';
import type { QuerySpec, Row } from '@/lib/data/types';

const h = vi.hoisted(() => ({
  accountId: 'account-a',
  flows: [] as Row[],
  nodes: [] as Row[],
  writes: [] as QuerySpec[],
}));
vi.mock('@/lib/flows/admin-client', () => ({
  databaseAdmin: () => {
    throw new Error(
      'An HTTP request must retain its authenticated tenant client'
    );
  },
}));
vi.mock('@/lib/data/server', () => ({ createClient: async () => db() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    db: db(),
    accountId: h.accountId,
    userId: 'author',
    role: 'agent',
  }),
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));

function db() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'author' } }, error: null }),
    },
    from: (table: string) =>
      buildQuery(table, async (spec) => {
        const source = table === 'flows' ? h.flows : h.nodes;
        const matches = (row: Row) =>
          row.account_id === h.accountId &&
          spec.filters.every((f) => row[f.field] === f.value);
        const found = source.filter(matches);
        if (spec.operation === 'update') {
          h.writes.push(spec);
          for (const row of found) Object.assign(row, spec.values);
        }
        if (spec.operation === 'delete') {
          h.writes.push(spec);
          const remaining = source.filter((row) => !matches(row));
          if (table === 'flows') h.flows = remaining;
          else h.nodes = remaining;
        }
        if (spec.operation === 'insert') {
          h.writes.push(spec);
          const values = Array.isArray(spec.values)
            ? spec.values
            : [spec.values!];
          source.push(
            ...values.map((row) => ({ ...row, account_id: h.accountId }))
          );
        }
        return {
          data: spec.cardinality ? (found[0] ?? null) : found,
          error: null,
        };
      }),
  };
}
import { PUT, DELETE } from './route';
const context = { params: Promise.resolve({ id: 'flow-a' }) };
beforeEach(() => {
  h.accountId = 'account-a';
  h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Original' }];
  h.nodes = [{ flow_id: 'flow-a', account_id: 'account-a', node_key: 'old' }];
  h.writes = [];
});
it('retains the request client when updating the graph and deleting the flow', async () => {
  const result = await PUT(
    new Request('http://localhost/api/flows/flow-a', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Saved',
        nodes: [{ node_key: 'new', node_type: 'end', config: {} }],
      }),
    }),
    context
  );
  expect(result.status).toBe(200);
  expect(h.flows[0].name).toBe('Saved');
  expect(h.nodes.map((node) => node.node_key)).toEqual(['new']);
  expect((await DELETE(new Request('http://localhost/'), context)).status).toBe(
    200
  );
  expect(h.flows).toEqual([]);
});
it('rejects a foreign account before any flow or node mutation', async () => {
  h.accountId = 'account-b';
  expect(
    (
      await PUT(
        new Request('http://localhost/', {
          method: 'PUT',
          body: JSON.stringify({ name: 'Foreign' }),
        }),
        context
      )
    ).status
  ).toBe(404);
  expect((await DELETE(new Request('http://localhost/'), context)).status).toBe(
    404
  );
  expect(h.writes).toEqual([]);
  expect(h.flows[0].name).toBe('Original');
});

it('rejects invalid active graph and header saves before any mutation', async () => {
  Object.assign(h.flows[0], { status: 'active', trigger_type: 'manual', trigger_config: {}, entry_node_id: 'old' });
  Object.assign(h.nodes[0], { node_type: 'end', config: {} });
  for (const body of [{ nodes: [] }, { entry_node_id: 'removed' }, { trigger_type: 'keyword', trigger_config: {} }]) {
    const response = await PUT(new Request('http://localhost/', { method: 'PUT', body: JSON.stringify(body) }), context);
    expect(response.status).toBe(422);
    expect((await response.json()).issues.some((issue: { severity: string }) => issue.severity === 'error')).toBe(true);
    expect(h.writes).toEqual([]);
  }
});
