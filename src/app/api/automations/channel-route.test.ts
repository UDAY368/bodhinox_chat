import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stage 1 channel rules on the automation routes: the channel chosen on create
// (WhatsApp when absent), the per-channel trigger and step palettes, the lock
// on PATCH, the copy keeping its channel, the list filter, 409 channel_disabled
// on activation, and the manual engine trigger's channel. The database and the
// channel state are in-memory stubs; role, RLS and tenancy are unchanged (see
// route.test.ts and publish-route.test.ts).

const ACC = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000b1';

const h = vi.hoisted(() => ({
  state: {
    row: {} as Record<string, unknown>,
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
    writes: [] as string[],
    filters: [] as Array<[string, unknown]>,
    channels: { whatsapp: true, instagram: true } as Record<string, boolean>,
    activations: [] as string[],
    dispatched: [] as Record<string, unknown>[],
  },
}));

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock('@/lib/data/server', () => ({ createClient: async () => fakeDb() }));
vi.mock('@/lib/auth/account', async (original) => ({
  ...(await original<typeof import('@/lib/auth/account')>()),
  requireRole: async () => ({ accountId: ACC, userId: USER, role: 'agent', db: fakeDb(), account: { id: ACC, name: 'A' } }),
  getCurrentAccount: async () => ({ accountId: ACC, userId: USER, role: 'agent', db: fakeDb(), account: { id: ACC, name: 'A' } }),
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: async () => {} }));
vi.mock('@/lib/workspace/attributes', () => ({ secretAttributeKeys: async () => new Set() }));
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: async () => true }));
vi.mock('@/lib/automations/steps-tree', () => ({
  loadStepsTree: async () => [],
  replaceSteps: async () => null,
  insertSteps: async () => null,
}));
vi.mock('@/lib/automations/template-check', () => ({ automationTemplateIssues: async () => [] }));
vi.mock('@/lib/automations/schedule-gate', () => ({ requireScheduledSendingAllowed: async () => {} }));
vi.mock('@/lib/automations/activation-lock', () => ({
  activateWithLoopLock: async (_tenant: unknown, _acc: string, automationId: string) => {
    h.state.activations.push(automationId);
    return null;
  },
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_tenant: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/channels/workspace', () => ({
  getWorkspaceChannels: async () => ({
    channels: {
      whatsapp: { enabled: h.state.channels.whatsapp },
      instagram: { enabled: h.state.channels.instagram },
    },
  }),
}));
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_scope: unknown, action: () => unknown) => action() }));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: async (input: Record<string, unknown>) => {
    h.state.dispatched.push(input);
    return true;
  },
}));

function fakeDb() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    from(table: string) {
      let byId = false;
      const result = () => {
        if (table === 'automations') return { data: byId ? h.state.row : [h.state.row], error: null };
        if (table === 'profiles') return { data: { account_id: ACC }, error: null };
        return { data: [], error: null };
      };
      const api: Record<string, unknown> = {
        select: () => api,
        in: () => api,
        order: () => api,
        eq: (col: string, value: unknown) => {
          h.state.filters.push([`${table}.${col}`, value]);
          if (col === 'id') byId = true;
          return api;
        },
        update: () => {
          h.state.writes.push(`${table}:update`);
          return api;
        },
        delete: () => {
          h.state.writes.push(`${table}:delete`);
          return api;
        },
        insert: (values: Record<string, unknown>) => {
          h.state.inserts.push({ table, values });
          h.state.writes.push(`${table}:insert`);
          return { select: () => ({ single: async () => ({ data: { id: 'new', ...values }, error: null }) }) };
        },
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return api;
    },
  };
}

import { GET, POST } from './route';
import { PATCH } from './[id]/route';
import { POST as DUPLICATE } from './[id]/duplicate/route';
import { POST as ENGINE } from './engine/route';

type Res = { status: number; body: { error?: string; code?: string; automation?: Record<string, unknown>; issues?: { path: string }[] } };
const params = Promise.resolve({ id: 'auto-1' });
const post = async (body: unknown) =>
  (await POST(new Request('http://t/api/automations', { method: 'POST', body: JSON.stringify(body) }))) as unknown as Res;
const patch = async (body: unknown) =>
  (await PATCH(new Request('http://t/', { method: 'PATCH', body: JSON.stringify(body) }), { params })) as unknown as Res;
const created = () => h.state.inserts.find((i) => i.table === 'automations')?.values;
const send = (text = 'Hi') => ({ step_type: 'send_message', step_config: { text } });

beforeEach(() => {
  h.state.row = { id: 'auto-1', account_id: ACC, name: 'A', is_active: false, trigger_type: 'new_message_received', trigger_config: {} };
  h.state.inserts = [];
  h.state.writes = [];
  h.state.filters = [];
  h.state.channels = { whatsapp: true, instagram: true };
  h.state.activations = [];
  h.state.dispatched = [];
});

describe('create', () => {
  it('makes a WhatsApp automation when no channel is given (API-key and older clients)', async () => {
    const res = await post({ name: 'n', trigger_type: 'new_message_received', steps: [send()] });
    expect(res.status).toBe(201);
    expect(created()).toMatchObject({ channel: 'whatsapp', account_id: ACC });
  });

  it('makes an automation in the section the request names', async () => {
    const res = await post({ name: 'n', channel: 'instagram', trigger_type: 'keyword_match', trigger_config: { keywords: ['hi'] }, steps: [send()] });
    expect(res.status).toBe(201);
    expect(created()).toMatchObject({ channel: 'instagram' });
  });

  it('refuses an unknown channel before writing anything', async () => {
    const res = await post({ name: 'n', channel: 'telegram', trigger_type: 'new_message_received' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_channel');
    expect(h.state.writes).toEqual([]);
  });

  it('refuses an Instagram trigger outside its palette, even as a draft', async () => {
    for (const trigger_type of ['time_based', 'ad_click', 'appointment_booked']) {
      const res = await post({ name: 'n', channel: 'instagram', trigger_type, is_active: false, steps: [send()] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('unavailable_on_channel');
    }
    expect(h.state.writes).toEqual([]);
  });

  it('refuses an Instagram step outside its palette, inside a branch too', async () => {
    const res = await post({ name: 'n', channel: 'instagram', trigger_type: 'new_message_received', steps: [{
      step_type: 'condition', step_config: { subject: 'message_content', value: 'x' },
      branches: { yes: [{ step_type: 'send_template', step_config: { template_name: 't' } }], no: [] },
    }] });
    expect(res.status).toBe(400);
    expect(res.body.issues?.[0].path).toBe('steps[0].yes.steps[0]');
    expect(h.state.writes).toEqual([]);
  });

  it('keeps every trigger and step available to WhatsApp', async () => {
    const res = await post({ name: 'n', channel: 'whatsapp', trigger_type: 'time_based', trigger_config: { schedule: '0 9 * * *' },
      steps: [{ step_type: 'send_template', step_config: { template_name: 't' } }] });
    expect(res.status).toBe(201);
  });

  it('takes a starter template only in a section it is made for', async () => {
    expect((await post({ channel: 'instagram', template: 'follow_up_reminder' })).status).toBe(400);
    expect(h.state.writes).toEqual([]);
    const res = await post({ channel: 'instagram', template: 'welcome_message' });
    expect(res.status).toBe(201);
    expect(created()).toMatchObject({ channel: 'instagram', trigger_type: 'first_inbound_message' });
  });

  it('refuses activation in a channel the workspace turned off (409 channel_disabled)', async () => {
    h.state.channels.instagram = false;
    const res = await post({ name: 'n', channel: 'instagram', trigger_type: 'new_message_received', is_active: true, steps: [send()] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('channel_disabled');
    expect(h.state.writes).toEqual([]);
    // A draft in that channel is still allowed.
    expect((await post({ name: 'n', channel: 'instagram', trigger_type: 'new_message_received', is_active: false, steps: [send()] })).status).toBe(201);
  });

  it('activates in an enabled channel through the locked re-check', async () => {
    const res = await post({ name: 'n', channel: 'instagram', trigger_type: 'new_message_received', is_active: true, steps: [send()] });
    expect(res.status).toBe(201);
    expect(h.state.activations).toEqual(['new']);
  });

  it('refuses activating an Instagram reply-button step that does not fit quick replies', async () => {
    const list = { kind: 'list', body: 'Pick', button_label: 'Open', sections: [{ rows: [{ id: 'a', title: 'A' }] }] };
    const res = await post({ name: 'n', channel: 'instagram', trigger_type: 'new_message_received', is_active: true,
      steps: [{ step_type: 'send_buttons', step_config: list }] });
    expect(res.status).toBe(400);
    expect(h.state.writes).toEqual([]);
  });
});

describe('edit', () => {
  it('refuses moving an automation to another channel (409 channel_locked)', async () => {
    const res = await patch({ channel: 'instagram', name: 'moved' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('channel_locked');
    expect(h.state.writes).toEqual([]);
  });

  it('accepts a save that repeats the automation\'s own channel', async () => {
    h.state.row = { ...h.state.row, channel: 'instagram' };
    expect((await patch({ channel: 'instagram', name: 'same' })).status).toBe(200);
  });

  it('keeps an Instagram automation to the Instagram palette', async () => {
    h.state.row = { ...h.state.row, channel: 'instagram' };
    expect((await patch({ trigger_type: 'time_based' })).status).toBe(400);
    expect((await patch({ steps: [{ step_type: 'send_list', step_config: {} }] })).status).toBe(400);
    expect(h.state.writes).toEqual([]);
  });

  it('refuses turning an automation on while its channel is off', async () => {
    h.state.row = { ...h.state.row, channel: 'instagram' };
    h.state.channels.instagram = false;
    const res = await patch({ is_active: true, steps: [send()] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('channel_disabled');
    expect(h.state.activations).toEqual([]);
  });

  it('pauses an automation whatever its channel\'s state', async () => {
    h.state.row = { ...h.state.row, channel: 'instagram', is_active: true };
    h.state.channels.instagram = false;
    expect((await patch({ is_active: false })).status).toBe(200);
  });
});

describe('duplicate', () => {
  it('copies the channel into the caller\'s workspace', async () => {
    h.state.row = { ...h.state.row, channel: 'instagram' };
    const res = (await DUPLICATE(new Request('http://t/', { method: 'POST' }), { params })) as unknown as Res;
    expect(res.status).toBe(201);
    expect(created()).toMatchObject({ channel: 'instagram', account_id: ACC, is_active: false });
  });

  it('copies a row read without the column as WhatsApp', async () => {
    await DUPLICATE(new Request('http://t/', { method: 'POST' }), { params });
    expect(created()).toMatchObject({ channel: 'whatsapp' });
  });
});

describe('list', () => {
  it('filters by ?channel=', async () => {
    const res = (await GET(new Request('http://t/api/automations?channel=instagram'))) as unknown as Res;
    expect(res.status).toBe(200);
    expect(h.state.filters).toContainEqual(['automations.channel', 'instagram']);
  });

  it('returns every automation without the parameter', async () => {
    expect(((await GET(new Request('http://t/api/automations'))) as unknown as Res).status).toBe(200);
    expect(h.state.filters.some(([key]) => key === 'automations.channel')).toBe(false);
  });

  it('refuses an unknown channel', async () => {
    const res = (await GET(new Request('http://t/api/automations?channel=sms'))) as unknown as Res;
    expect(res.status).toBe(400);
  });
});

describe('manual engine trigger', () => {
  const fire = async (body: unknown) =>
    (await ENGINE(new Request('http://t/', { method: 'POST', body: JSON.stringify(body) }))) as unknown as Res;

  it('runs WhatsApp automations when no channel is given', async () => {
    expect((await fire({ trigger_type: 'new_message_received' })).status).toBe(200);
    expect(h.state.dispatched[0]).toMatchObject({ accountId: ACC, channel: 'whatsapp' });
  });

  it('runs the named channel\'s automations', async () => {
    await fire({ trigger_type: 'new_message_received', channel: 'instagram' });
    expect(h.state.dispatched[0]).toMatchObject({ channel: 'instagram' });
  });

  it('refuses an unknown channel without dispatching', async () => {
    expect((await fire({ trigger_type: 'new_message_received', channel: 'sms' })).status).toBe(400);
    expect(h.state.dispatched).toEqual([]);
  });
});
