import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@/lib/auth/errors';

// Phase 12 save rules for automations: the automations.publish permission,
// the secret-webhook admin gate, the save-time destination check and the
// tag_added loop check (422). The database is an in-memory stub.

const ACC = '00000000-0000-4000-8000-0000000000a1';
const TAG_X = '00000000-0000-4000-8000-0000000000f1';
const TAG_Y = '00000000-0000-4000-8000-0000000000f2';

const h = vi.hoisted(() => ({
  state: {
    role: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer',
    permissionDenied: false,
    deliverable: true,
    row: {} as Record<string, unknown>,
    active: [] as Record<string, unknown>[],
    otherSteps: [] as Record<string, unknown>[],
    storedSteps: [] as Record<string, unknown>[],
    writes: [] as string[],
    // What the locked re-check finds (a loop closed by a concurrent activation), and its calls.
    lockedChain: null as string[] | null,
    activations: [] as Array<{ automationId: string }>,
  },
}));

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock('@/lib/data/server', () => ({ createClient: async () => fakeDb() }));
vi.mock('@/lib/auth/account', async (original) => ({
  ...(await original<typeof import('@/lib/auth/account')>()),
  requireRole: async () => ({ accountId: ACC, userId: '00000000-0000-4000-8000-0000000000b1', role: h.state.role, db: fakeDb(), account: { id: ACC, name: 'A' } }),
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async () => {
    if (h.state.permissionDenied) throw new ForbiddenError('Insufficient workspace role');
  },
}));
vi.mock('@/lib/workspace/attributes', () => ({ secretAttributeKeys: async () => new Set(['api_key']) }));
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: async () => h.state.deliverable }));
vi.mock('@/lib/automations/steps-tree', () => ({
  loadStepsTree: async () => h.state.storedSteps,
  replaceSteps: async () => null,
  insertSteps: async () => null,
}));
vi.mock('@/lib/automations/template-check', () => ({ automationTemplateIssues: async () => [] }));
vi.mock('@/lib/billing/activation', () => ({ requireActiveAutomationRoom: async () => {} }));
vi.mock('@/lib/automations/schedule-gate', () => ({ requireScheduledSendingAllowed: async () => {} }));
vi.mock('@/lib/automations/activation-lock', () => ({
  activateWithLoopLock: async (_tenant: unknown, _acc: string, automationId: string) => {
    h.state.activations.push({ automationId });
    return h.state.lockedChain;
  },
}));

function fakeDb() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-0000000000b1' } } }) },
    from(table: string) {
      let op = 'select';
      let byId = false;
      const result = () => {
        if (table === 'automations') return { data: byId ? h.state.row : h.state.active, error: null };
        if (table === 'automation_steps') return { data: h.state.otherSteps, error: null };
        if (table === 'profiles') return { data: { account_id: ACC }, error: null };
        return { data: null, error: null };
      };
      const api: Record<string, unknown> = {
        select: () => api,
        in: () => api,
        order: () => api,
        eq: (col: string) => {
          if (col === 'id') byId = true;
          return api;
        },
        update: () => {
          op = 'update';
          return api;
        },
        delete: () => {
          h.state.writes.push(`${table}:delete`);
          return api;
        },
        insert: (values?: Record<string, unknown>) => {
          h.state.writes.push(values && 'is_active' in values ? `${table}:insert:active=${values.is_active}` : `${table}:insert`);
          return { select: () => ({ single: async () => ({ data: { id: 'new' }, error: null }) }) };
        },
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: unknown) => unknown) => {
          if (op === 'update') h.state.writes.push(`${table}:update`);
          return Promise.resolve(result()).then(resolve);
        },
      };
      return api;
    },
  };
}

import { PATCH } from './[id]/route';
import { POST } from './route';

const params = Promise.resolve({ id: 'auto-1' });
type Res = { status: number; body: { error?: string; issues?: { message: string }[] } };
const patch = async (body: unknown) =>
  (await PATCH(new Request('http://t/', { method: 'PATCH', body: JSON.stringify(body) }), { params })) as unknown as Res;

const secretWebhook = (id = 'step-1') => ({
  id,
  step_type: 'send_webhook',
  step_config: { url: 'https://hooks.example.com/x', headers: { authorization: 'Bearer {{workspace.api_key}}' }, body_template: '{}' },
});

beforeEach(() => {
  h.state.role = 'agent';
  h.state.permissionDenied = false;
  h.state.deliverable = true;
  h.state.row = { id: 'auto-1', account_id: ACC, name: 'C', is_active: false, trigger_type: 'tag_added', trigger_config: { tag_id: TAG_Y } };
  h.state.active = [];
  h.state.otherSteps = [];
  h.state.storedSteps = [];
  h.state.writes = [];
  h.state.lockedChain = null;
  h.state.activations = [];
});

describe('secret webhook gate', () => {
  it('refuses an agent adding a webhook step that uses a secret', async () => {
    const res = await patch({ steps: [secretWebhook()] });
    expect(res.status).toBe(403);
    expect(h.state.writes).toEqual([]);
  });

  it('lets an agent keep an admin step unchanged', async () => {
    h.state.storedSteps = [secretWebhook()];
    expect((await patch({ steps: [secretWebhook()], name: 'renamed' })).status).toBe(200);
  });

  it('lets an admin add one', async () => {
    h.state.role = 'admin';
    expect((await patch({ steps: [secretWebhook()] })).status).toBe(200);
  });

  it('applies to a new automation too', async () => {
    const res = (await POST(new Request('http://t/', {
      method: 'POST',
      body: JSON.stringify({ name: 'n', trigger_type: 'new_message_received', is_active: false, steps: [secretWebhook()] }),
    }))) as unknown as Res;
    expect(res.status).toBe(403);
    expect(h.state.writes).toEqual([]);
  });
});

describe('publishing (a save that ends active)', () => {
  const addTag = (tag: string) => ({ id: 's-add', step_type: 'add_tag', step_config: { tag_id: tag } });

  it('needs the automations.publish permission', async () => {
    h.state.permissionDenied = true;
    const res = await patch({ is_active: true, steps: [addTag(TAG_X)] });
    expect(res.status).toBe(403);
    expect(h.state.writes).toEqual([]);
  });

  it('does not need it for a draft save', async () => {
    h.state.permissionDenied = true;
    expect((await patch({ name: 'draft' })).status).toBe(200);
  });

  it('refuses a webhook destination that is not public', async () => {
    h.state.deliverable = false;
    const res = await patch({ is_active: true, steps: [{ step_type: 'send_webhook', step_config: { url: 'https://internal.example.com/' } }] });
    expect(res.status).toBe(400);
  });

  it('returns 422 for a tag_added loop: A adds X, B on X adds Y, C on Y adds X', async () => {
    h.state.active = [
      { id: 'auto-a', name: 'A', trigger_type: 'new_message_received', trigger_config: {} },
      { id: 'auto-b', name: 'B', trigger_type: 'tag_added', trigger_config: { tag_id: TAG_X } },
    ];
    h.state.otherSteps = [
      { automation_id: 'auto-a', step_type: 'add_tag', step_config: { tag_id: TAG_X } },
      { automation_id: 'auto-b', step_type: 'add_tag', step_config: { tag_id: TAG_Y } },
    ];
    const res = await patch({ is_active: true, steps: [addTag(TAG_X)] });
    expect(res.status).toBe(422);
    expect(res.body.issues?.[0].message).toBeTruthy();
    expect(h.state.writes).toEqual([]);
  });

  it('allows the same chain when it ends', async () => {
    h.state.active = [{ id: 'auto-b', name: 'B', trigger_type: 'tag_added', trigger_config: { tag_id: TAG_X } }];
    h.state.otherSteps = [];
    expect((await patch({ is_active: true, steps: [addTag(TAG_X)] })).status).toBe(200);
    // Turned on only through the per-account locked re-check.
    expect(h.state.activations).toEqual([{ automationId: 'auto-1' }]);
  });

  it('refuses (422) an activation whose locked re-check finds a loop a concurrent activation closed', async () => {
    h.state.lockedChain = ['C', 'B', 'C'];
    const res = await patch({ is_active: true, steps: [addTag(TAG_X)] });
    expect(res.status).toBe(422);
    expect(h.state.activations).toHaveLength(1);
  });

  it('creates a new automation off and removes it when the locked re-check finds a loop', async () => {
    h.state.lockedChain = ['C', 'B', 'C'];
    const res = (await POST(new Request('http://t/', { method: 'POST', body: JSON.stringify({
      name: 'C', trigger_type: 'tag_added', trigger_config: { tag_id: TAG_Y }, is_active: true, steps: [addTag(TAG_X)],
    }) }))) as unknown as Res;
    expect(res.status).toBe(422);
    expect(h.state.writes).toEqual(['automations:insert:active=false', 'automations:delete']);
  });
});
