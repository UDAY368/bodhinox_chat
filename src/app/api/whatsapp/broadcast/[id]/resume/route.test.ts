import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-11111111111a';
const h = vi.hoisted(() => ({
  broadcast: null as Record<string, unknown> | null,
  numbers: [] as Record<string, unknown>[],
  enqueued: [] as unknown[][],
  permissionDenied: false,
  permissionChecks: [] as unknown[][],
  recipients: [] as Record<string, unknown>[],
  unpaused: [] as unknown[][],
  steps: [] as string[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'acct',
    userId: 'u-1',
    role: 'agent',
    db: {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        let update: Record<string, unknown> | null = null;
        const source = () => table === 'broadcasts' ? (h.broadcast ? [h.broadcast] : []) : table === 'whatsapp_config' ? h.numbers
          : table === 'broadcast_recipients' ? h.recipients : [];
        const rows = () => source().filter((r) => Object.entries(filters).every(([k, v]) =>
          k === 'account_id' || (Array.isArray(v) ? v.includes(r[k]) : v === null ? r[k] == null : r[k] === v)));
        const b: Record<string, unknown> = {
          select: () => b,
          update: (row: Record<string, unknown>) => { update = row; return b; },
          eq: (field: string, value: unknown) => { filters[field] = value; return b; },
          in: (field: string, value: unknown[]) => { filters[field] = value; return b; },
          is: (field: string, value: unknown) => { filters[field] = value; return b; },
          single: async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: 'none' } }),
          maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
          then: (resolve: (r: { data: unknown[]; count: number; error: null }) => unknown) => {
            const matched = rows();
            if (update) for (const r of matched) Object.assign(r, update);
            return resolve({ data: matched, count: matched.length, error: null });
          },
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
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: async (...args: unknown[]) => { h.enqueued.push(args); h.steps.push('enqueue'); return 'job-1'; } }));
vi.mock('@/lib/broadcasts/pause', () => ({
  unpauseBroadcast: async (...args: unknown[]) => { h.unpaused.push(args); h.steps.push('unpause'); return true; },
}));

import { POST } from './route';
import { UNCERTAIN_SEND_MESSAGE } from '@/lib/whatsapp/broadcast-core';
import { RESUME_MAX_PER_REQUEST } from '@/lib/whatsapp/broadcast-resume';

const resume = (scope = 'pending') => POST(
  new Request('http://localhost/api/whatsapp/broadcast/b-1/resume', { method: 'POST', body: JSON.stringify({ scope }) }),
  { params: Promise.resolve({ id: 'b-1' }) },
);
const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString();
const connected = { id: A, phone_number_id: '1000', access_token: 'enc', status: 'connected', is_default: true };
const disconnected = { ...connected, access_token: '', status: 'disconnected', is_default: false };

describe('POST /api/whatsapp/broadcast/[id]/resume for a held campaign', () => {
  beforeEach(() => { h.enqueued = []; h.numbers = [connected]; h.permissionDenied = false; h.permissionChecks = []; h.recipients = []; });

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

describe('POST /api/whatsapp/broadcast/[id]/resume confirmation count (audit findings 11, 12, 15)', () => {
  beforeEach(() => {
    h.enqueued = []; h.numbers = [connected]; h.permissionDenied = false; h.permissionChecks = [];
    h.broadcast = { id: 'b-1', status: 'sent', scheduled_at: null, whatsapp_config_id: A };
  });
  const row = (status: string, extra: Record<string, unknown> = {}) =>
    ({ broadcast_id: 'b-1', status, outcome_uncertain_at: null, error_message: status === 'failed' ? 'boom' : null, ...extra });

  it('answers with the real number of recipients a Resume covers', async () => {
    h.broadcast = { id: 'b-1', status: 'sending', scheduled_at: null, whatsapp_config_id: A };
    h.recipients = [row('pending'), row('pending'), row('pending'), row('failed'), row('sent')];
    const body = await (await resume('pending')).json();
    expect(body).toMatchObject({ resuming: 3, remaining: 0 });
  });

  it('counts failed rows for Retry failed, leaving out uncertain sends, including legacy ones by their text', async () => {
    const legacy = row('failed', { error_message: UNCERTAIN_SEND_MESSAGE });
    h.recipients = [row('failed'), row('failed'), row('failed', { outcome_uncertain_at: '2026-11-10T00:00:00Z' }), legacy, row('pending')];
    const res = await resume('failed');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ resuming: 2, remaining: 0 });
    // The legacy row now carries the flag, so the worker leaves it out too.
    expect(legacy.outcome_uncertain_at).toEqual(expect.any(String));
  });

  it('gives each Retry failed its own retry id, so the worker sends rows Meta failed after accepting them again', async () => {
    h.recipients = [row('failed', { whatsapp_message_id: 'wamid.1' })];
    await resume('failed');
    await resume('failed');
    const [first, second] = h.enqueued.map((call) => call[1] as { retryId?: string });
    expect(first.retryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.retryId).not.toBe(first.retryId);
    expect(h.enqueued[0][2]).toMatchObject({ dedupeKey: `broadcast:b-1:retry:${first.retryId}` });
  });

  it('caps a retry at one pass and reports the rest', async () => {
    h.recipients = Array.from({ length: RESUME_MAX_PER_REQUEST + 5 }, () => row('failed'));
    expect(await (await resume('failed')).json()).toMatchObject({ resuming: RESUME_MAX_PER_REQUEST, remaining: 5 });
  });

  it('answers 0 when nothing is in scope', async () => {
    h.recipients = [row('sent')];
    expect(await (await resume('failed')).json()).toMatchObject({ resuming: 0, remaining: 0 });
  });
});

describe('POST /api/whatsapp/broadcast/[id]/resume for paused and Instagram campaigns', () => {
  beforeEach(() => {
    h.enqueued = []; h.numbers = [connected]; h.permissionDenied = false; h.permissionChecks = []; h.unpaused = []; h.steps = [];
    h.recipients = [{ broadcast_id: 'b-1', status: 'pending', outcome_uncertain_at: null }];
  });

  it('puts a paused campaign back to sending before queueing its pass, in the caller tenant', async () => {
    h.broadcast = { id: 'b-1', status: 'paused', scheduled_at: null, whatsapp_config_id: A };
    expect((await resume()).status).toBe(202);
    expect(h.unpaused).toEqual([[{ accountId: 'acct', userId: 'u-1', role: 'agent' }, 'b-1']]);
    expect(h.steps).toEqual(['unpause', 'enqueue']);
  });

  it('refuses a failed or all retry on a paused campaign without unpausing or queueing anything', async () => {
    h.broadcast = { id: 'b-1', status: 'paused', scheduled_at: null, whatsapp_config_id: A };
    for (const scope of ['failed', 'all']) {
      const res = await POST(new Request('http://localhost/api/whatsapp/broadcast/b-1/resume', {
        method: 'POST', body: JSON.stringify({ scope }),
      }), { params: Promise.resolve({ id: 'b-1' }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'resume_paused_first' });
    }
    expect(h.unpaused).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it('never unpauses when campaigns.send is turned off', async () => {
    h.broadcast = { id: 'b-1', status: 'paused', scheduled_at: null, whatsapp_config_id: A };
    h.permissionDenied = true;
    expect((await resume()).status).toBe(403);
    expect(h.unpaused).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it('does not need a WhatsApp number for an Instagram campaign and never forwards header media', async () => {
    h.broadcast = { id: 'b-1', status: 'sending', scheduled_at: null, whatsapp_config_id: null, channel: 'instagram' };
    h.numbers = [disconnected];
    const res = await POST(new Request('http://localhost/api/whatsapp/broadcast/b-1/resume', {
      method: 'POST', body: JSON.stringify({ scope: 'pending', headerMediaUrl: 'https://example.com/a.png' }),
    }), { params: Promise.resolve({ id: 'b-1' }) });
    expect(res.status).toBe(202);
    expect(h.enqueued[0][1]).toEqual({ broadcastId: 'b-1', scope: 'pending' });
  });
});
