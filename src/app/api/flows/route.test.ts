import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQuery } from '@/lib/data/builder';
import type { QuerySpec, Row } from '@/lib/data/types';

// GET/POST /api/flows per channel (Stage 1): a section lists its own flows plus
// legacy 'any' ones, a create belongs to one channel, and API clients that
// name no channel keep today's behaviour (every flow; new flows on WhatsApp).
const h = vi.hoisted(() => ({
  accountId: 'account-a',
  role: 'agent',
  flows: [] as Row[],
  nodes: [] as Row[],
  writes: [] as QuerySpec[],
  signedIn: true,
}));

class Forbidden extends Error {
  status = 403;
}
vi.mock('@/lib/data/server', () => ({ createClient: async () => db() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async (minimum: string) => {
    if (minimum === 'agent' && h.role === 'viewer') throw new Forbidden();
    return { db: db(), accountId: h.accountId, userId: 'author', role: h.role };
  },
  toErrorResponse: (err: unknown) => Response.json({ error: 'Forbidden' }, { status: err instanceof Forbidden ? 403 : 500 }),
}));

let nextId = 0;
function db() {
  return {
    auth: { getUser: async () => ({ data: { user: h.signedIn ? { id: 'author' } : null }, error: null }) },
    from: (table: string) =>
      buildQuery(table, async (spec) => {
        const source = table === 'flows' ? h.flows : table === 'flow_nodes' ? h.nodes : [{ account_id: h.accountId, user_id: 'author' }];
        // RLS: the caller sees only its own account's rows.
        const matches = (row: Row) => row.account_id === h.accountId && spec.filters.every((f) =>
          f.op === 'in' ? (f.value as unknown[]).includes(row[f.field]) : row[f.field] === f.value);
        if (spec.operation === 'insert') {
          h.writes.push(spec);
          const values = (Array.isArray(spec.values) ? spec.values : [spec.values!]).map((row) => ({
            id: table === 'flows' ? `flow-${++nextId}` : undefined, ...row,
          }));
          source.push(...values);
          return { data: spec.cardinality ? values[0] : values, error: null };
        }
        const found = source.filter(matches);
        return { data: spec.cardinality ? (found[0] ?? null) : found, error: null };
      }),
  };
}

import { GET, POST } from './route';

const list = (query = '') => GET(new Request(`http://localhost/api/flows${query}`));
const create = (body: unknown) => POST(new Request('http://localhost/api/flows', { method: 'POST', body: JSON.stringify(body) }));
const flow = (id: string, channel_scope: string, account_id = 'account-a') => ({ id, account_id, name: id, channel_scope });

beforeEach(() => {
  h.accountId = 'account-a';
  h.role = 'agent';
  h.signedIn = true;
  h.writes = [];
  h.nodes = [];
  h.flows = [flow('wa', 'whatsapp'), flow('ig', 'instagram'), flow('both', 'any'), flow('other', 'whatsapp', 'account-b')];
});

describe('GET /api/flows', () => {
  it("lists one section: the channel's own flows plus legacy flows on both channels", async () => {
    const whatsapp = await (await list('?channel=whatsapp')).json();
    expect(whatsapp.flows.map((f: Row) => f.id).sort()).toEqual(['both', 'wa']);
    const instagram = await (await list('?channel=instagram')).json();
    expect(instagram.flows.map((f: Row) => f.id).sort()).toEqual(['both', 'ig']);
  });

  it("lists every flow of the caller's workspace without a channel (API clients), never another workspace's", async () => {
    const all = await (await list()).json();
    expect(all.flows.map((f: Row) => f.id).sort()).toEqual(['both', 'ig', 'wa']);
  });

  it('refuses an unknown channel and a signed-out caller', async () => {
    expect((await list('?channel=sms')).status).toBe(400);
    expect((await list('?channel=any')).status).toBe(400);
    h.signedIn = false;
    expect((await list('?channel=whatsapp')).status).toBe(401);
  });
});

describe('POST /api/flows', () => {
  const inserted = () => h.writes.filter((w) => w.resource === 'flows').map((w) => w.values as Row);

  it('creates a blank flow in the asked-for channel, and on WhatsApp when none is named', async () => {
    expect((await create({ name: 'IG', channel_scope: 'instagram' })).status).toBe(201);
    expect((await create({ name: 'Legacy client' })).status).toBe(201);
    expect(inserted().map((row) => row.channel_scope)).toEqual(['instagram', 'whatsapp']);
    expect(inserted()[0]).toMatchObject({ account_id: 'account-a', user_id: 'author', status: 'draft' });
  });

  it("refuses a new 'any' flow or an unknown channel without writing", async () => {
    for (const channel_scope of ['any', 'sms', 1, null]) {
      expect((await create({ name: 'x', channel_scope })).status).toBe(400);
    }
    expect(h.writes).toEqual([]);
  });

  it("creates a template in the asked-for channel only when the template fits it", async () => {
    // store_locator asks for a location: a WhatsApp-only step. welcome_menu fits both channels.
    expect((await create({ template_slug: 'store_locator' })).status).toBe(201);
    expect((await create({ template_slug: 'welcome_menu', channel_scope: 'instagram' })).status).toBe(201);
    expect(inserted().map((row) => row.channel_scope)).toEqual(['whatsapp', 'instagram']);
    h.writes = [];
    const refused = await create({ template_slug: 'store_locator', channel_scope: 'instagram' });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain('Instagram');
    expect(h.writes).toEqual([]);
  });

  it('refuses a viewer before reading the body', async () => {
    h.role = 'viewer';
    expect((await create({ name: 'x', channel_scope: 'whatsapp' })).status).toBe(403);
    expect(h.writes).toEqual([]);
  });
});
