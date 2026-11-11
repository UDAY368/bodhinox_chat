// Stage 3 (3C): the AI comment routes. While Instagram is off they answer 503
// before any session or database work; then session, Origin/CSRF, admin role,
// rate limit and strict bodies, and only then the service (mocked here;
// ai-comments.integration.test.ts runs it on PostgreSQL).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ITEM = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({ role: 'admin', signedIn: true, mutationOk: true, sessions: 0, calls: [] as string[], fail: null as unknown }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).ForbiddenError('Invalid origin');
  },
}));
vi.mock('@/lib/instagram/ai-comments-queue', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/ai-comments-queue')>()),
  getAiCommentSettings: async (actor: { accountId: string; role: string }) => {
    if (h.fail) throw h.fail;
    h.calls.push(`settings:${actor.accountId}:${actor.role}`);
    return { configured: true, aiActive: true, enabled: false, autoApprove: false, dailyCap: 50 };
  },
  listAiComments: async (actor: { accountId: string }, view: string) => {
    h.calls.push(`list:${actor.accountId}:${view}`);
    return [];
  },
  updateAiCommentSettings: async (actor: { accountId: string }, patch: unknown) => {
    if (h.fail) throw h.fail;
    h.calls.push(`update:${actor.accountId}:${JSON.stringify(patch)}`);
    return { configured: true, aiActive: true, enabled: true, autoApprove: false, dailyCap: 50 };
  },
  decideAiComment: async (actor: { accountId: string }, id: string, input: unknown) => {
    if (h.fail) throw h.fail;
    h.calls.push(`decide:${actor.accountId}:${id}:${JSON.stringify(input)}`);
    return (input as { decision: string }).decision === 'approve' ? 'approved' : 'rejected';
  },
}));

import { AiCommentError } from '@/lib/instagram/ai-comments-queue';
import { InstagramError } from '@/lib/instagram/errors';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, PUT } from './route';
import { POST } from './[id]/route';

const req = (path: string, method = 'GET', body?: unknown) =>
  new Request(`https://app.example.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id = ITEM) => ({ params: Promise.resolve({ id }) });
const BASE = '/api/instagram/ai-comments';

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('INSTAGRAM_ENABLED', '');
  Object.assign(h, { role: 'admin', signedIn: true, mutationOk: true, sessions: 0, calls: [], fail: null });
  __resetRateLimitForTests();
});

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

describe('while Instagram is off', () => {
  it('answers 503 before the session', async () => {
    for (const res of [await GET(req(BASE)), await PUT(req(BASE, 'PUT', { enabled: true })), await POST(req(`${BASE}/${ITEM}`, 'POST', { decision: 'reject' }), ctx())]) {
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('instagram_not_enabled');
    }
    expect(h.sessions).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe('GET', () => {
  beforeEach(enable);

  it('is open to any member, scoped to the session workspace, private and uncached', async () => {
    h.role = 'viewer';
    const res = await GET(req(`${BASE}?view=history`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.calls).toEqual([`settings:${ACCOUNT}:viewer`, `list:${ACCOUNT}:history`]);
  });

  it('refuses a signed-out caller and an unknown view', async () => {
    h.signedIn = false;
    expect((await GET(req(BASE))).status).toBe(401);
    h.signedIn = true;
    expect((await GET(req(`${BASE}?view=everything`))).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('bounds how often one user can have the page read comments from Meta', async () => {
    let last = 200;
    for (let i = 0; i < 32; i++) last = (await GET(req(BASE))).status;
    expect(last).toBe(429);
  });
});

describe('PUT settings', () => {
  beforeEach(enable);

  it('needs Origin/CSRF proof and an admin', async () => {
    h.mutationOk = false;
    expect((await PUT(req(BASE, 'PUT', { enabled: true }))).status).toBe(403);
    h.mutationOk = true;
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await PUT(req(BASE, 'PUT', { enabled: true }))).status).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });

  it('takes a strict body: no unknown keys, an integer cap of 1 to 500', async () => {
    for (const body of [{}, { enabled: 'yes' }, { daily_cap: 0 }, { daily_cap: 501 }, { daily_cap: 1.5 }, { enabled: true, account_id: ACCOUNT }]) {
      expect((await PUT(req(BASE, 'PUT', body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it('saves for the session workspace only', async () => {
    const res = await PUT(req(BASE, 'PUT', { enabled: true, auto_approve: false, daily_cap: 20 }));
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([`update:${ACCOUNT}:${JSON.stringify({ enabled: true, autoApprove: false, dailyCap: 20 })}`]);
  });

  it('answers 409 ai_not_configured without an AI setup', async () => {
    h.fail = new AiCommentError('ai_not_configured');
    const res = await PUT(req(BASE, 'PUT', { enabled: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('ai_not_configured');
  });
});

describe('POST decision', () => {
  beforeEach(enable);

  it('needs Origin/CSRF proof and an admin', async () => {
    h.mutationOk = false;
    expect((await POST(req(`${BASE}/${ITEM}`, 'POST', { decision: 'approve' }), ctx())).status).toBe(403);
    h.mutationOk = true;
    h.role = 'agent';
    expect((await POST(req(`${BASE}/${ITEM}`, 'POST', { decision: 'approve' }), ctx())).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('refuses a malformed id and a bad body', async () => {
    expect((await POST(req(`${BASE}/x`, 'POST', { decision: 'approve' }), ctx('x'))).status).toBe(404);
    for (const body of [{}, { decision: 'maybe' }, { decision: 'reject', reply_text: 'x' }, { decision: 'approve', extra: 1 }]) {
      expect((await POST(req(`${BASE}/${ITEM}`, 'POST', body), ctx())).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it('approves with an edited reply and rejects, as the session workspace', async () => {
    const approved = await POST(req(`${BASE}/${ITEM}`, 'POST', { decision: 'approve', reply_text: 'Edited' }), ctx());
    expect(await approved.json()).toEqual({ status: 'approved' });
    const rejected = await POST(req(`${BASE}/${ITEM}`, 'POST', { decision: 'reject' }), ctx());
    expect(await rejected.json()).toEqual({ status: 'rejected' });
    expect(h.calls).toEqual([
      `decide:${ACCOUNT}:${ITEM}:${JSON.stringify({ decision: 'approve', replyText: 'Edited' })}`,
      `decide:${ACCOUNT}:${ITEM}:${JSON.stringify({ decision: 'reject' })}`,
    ]);
  });

  it('answers 409 already_decided and 404 for a missing or foreign draft', async () => {
    h.fail = new AiCommentError('already_decided');
    const res = await POST(req(`${BASE}/${ITEM}`, 'POST', { decision: 'approve' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_decided');
    h.fail = new InstagramError('not_found');
    expect((await POST(req(`${BASE}/${ITEM}`, 'POST', { decision: 'reject' }), ctx())).status).toBe(404);
  });
});
