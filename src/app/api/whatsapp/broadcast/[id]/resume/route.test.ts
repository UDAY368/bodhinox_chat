import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-11111111111a';
const h = vi.hoisted(() => ({
  broadcast: null as Record<string, unknown> | null,
  numbers: [] as Record<string, unknown>[],
  enqueued: [] as unknown[][],
  permissionDenied: false,
  permissionChecks: [] as unknown[][],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'acct',
    userId: 'u-1',
    role: 'agent',
    db: {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const rows = () => (table === 'broadcasts' ? (h.broadcast ? [h.broadcast] : []) : table === 'whatsapp_config' ? h.numbers : [])
          .filter((r) => Object.entries(filters).every(([k, v]) => k === 'account_id' || r[k] === v));
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (field: string, value: unknown) => { filters[field] = value; return b; },
          single: async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: 'none' } }),
          maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
          then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
        };
        return b;
      },
    },
  }),
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async (...args: unknown[]) => {
    h.permissionChecks.push(args);
    if (h.permissionDenied) throw Object.assign(new Error('This feature is turned off for your role'), { status: 403 });
  },
}));
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: async (...args: unknown[]) => { h.enqueued.push(args); return 'job-1'; } }));

import { POST } from './route';

const resume = (scope = 'pending') => POST(
  new Request('http://localhost/api/whatsapp/broadcast/b-1/resume', { method: 'POST', body: JSON.stringify({ scope }) }),
  { params: Promise.resolve({ id: 'b-1' }) },
);
const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString();
const connected = { id: A, phone_number_id: '1000', access_token: 'enc', status: 'connected', is_default: true };
const disconnected = { ...connected, access_token: '', status: 'disconnected', is_default: false };

describe('POST /api/whatsapp/broadcast/[id]/resume for a held campaign', () => {
  beforeEach(() => { h.enqueued = []; h.numbers = [connected]; h.permissionDenied = false; h.permissionChecks = []; });

  it('requires campaigns.send for the caller and queues nothing when it is turned off', async () => {
    h.broadcast = { id: 'b-1', status: 'sending', scheduled_at: null, whatsapp_config_id: A };
    h.permissionDenied = true;
    expect((await resume()).status).toBe(403);
    expect(h.permissionChecks).toEqual([[{ accountId: 'acct', userId: 'u-1', role: 'agent' }, 'campaigns.send']]);
    expect(h.enqueued).toEqual([]);
  });

  it('refuses a draft campaign: drafts are started by create/schedule, never resume', async () => {
    h.broadcast = { id: 'b-1', status: 'draft', scheduled_at: null, whatsapp_config_id: A };
    for (const scope of ['pending', 'failed', 'all']) expect((await resume(scope)).status).toBe(409);
    expect(h.enqueued).toEqual([]);
  });

  it('refuses while its number is still disconnected, with the clear message and nothing queued', async () => {
    h.broadcast = { id: 'b-1', status: 'sending', scheduled_at: null, whatsapp_config_id: A };
    h.numbers = [disconnected];
    const res = await resume();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('whatsapp_number_disconnected');
    expect(body.error).toMatch(/disconnected/i);
    expect(h.enqueued).toEqual([]);
  });

  it('refuses a past-due scheduled campaign while its number is disconnected', async () => {
    h.broadcast = { id: 'b-1', status: 'scheduled', scheduled_at: past, whatsapp_config_id: A };
    h.numbers = [disconnected];
    expect((await resume()).status).toBe(409);
    expect(h.enqueued).toEqual([]);
  });

  it('resumes a held sending campaign once its number is connected again', async () => {
    h.broadcast = { id: 'b-1', status: 'sending', scheduled_at: null, whatsapp_config_id: A };
    const res = await resume();
    expect(res.status).toBe(202);
    expect(h.enqueued[0][0]).toBe('broadcast.dispatch');
    expect(h.enqueued[0][2]).toMatchObject({ tenantId: 'acct', requeueCompleted: true, dedupeKey: 'broadcast:b-1:initial' });
  });

  it('resumes a held past-due scheduled campaign once its number is connected again', async () => {
    h.broadcast = { id: 'b-1', status: 'scheduled', scheduled_at: past, whatsapp_config_id: A };
    expect((await resume()).status).toBe(202);
    expect(h.enqueued).toHaveLength(1);
  });

  it('still refuses a campaign scheduled for later, and a cancelled one', async () => {
    h.broadcast = { id: 'b-1', status: 'scheduled', scheduled_at: future, whatsapp_config_id: A };
    expect((await resume()).status).toBe(409);
    h.broadcast = { id: 'b-1', status: 'cancelled', scheduled_at: null, whatsapp_config_id: A };
    expect((await resume()).status).toBe(409);
    expect(h.enqueued).toEqual([]);
  });

  it('never resumes on another number: a legacy campaign with no number and none connected is refused', async () => {
    h.broadcast = { id: 'b-1', status: 'sending', scheduled_at: null, whatsapp_config_id: null };
    h.numbers = [disconnected];
    const res = await resume();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('whatsapp_not_configured');
    expect(h.enqueued).toEqual([]);
  });
});
