// Stage 2 (2E): the conversation-starter and rule-conversion routes. While
// Instagram is off they answer 503 before any session or database work; then
// session, Origin/CSRF, admin role, rate limit and strict bodies, and only
// then the service (mocked here; tools.integration.test.ts runs it on
// PostgreSQL).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const IG = '44444444-4444-4444-8444-444444444444';
const RULE = '55555555-5555-4555-8555-555555555555';
const FLOW = '66666666-6666-4666-8666-666666666666';

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
vi.mock('@/lib/instagram/ice-breakers', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/ice-breakers')>()),
  getConversationStarters: async (actor: { accountId: string; role: string }, id: string) => {
    if (h.fail) throw h.fail;
    h.calls.push(`get:${actor.accountId}:${actor.role}:${id}`);
    return { instagramAccountId: id, managed: true, syncedAt: null, starters: [] };
  },
  setConversationStarters: async (actor: { accountId: string }, id: string, starters: unknown) => {
    if (h.fail) throw h.fail;
    h.calls.push(`set:${actor.accountId}:${id}:${JSON.stringify(starters)}`);
    return { instagramAccountId: id, managed: true, syncedAt: null, starters: [] };
  },
}));
vi.mock('@/lib/instagram/comment-rule-convert', () => ({
  convertCommentRuleToFlow: async (actor: { accountId: string }, id: string, ruleId: string) => {
    if (h.fail) throw h.fail;
    h.calls.push(`convert:${actor.accountId}:${id}:${ruleId}`);
    return { flowId: FLOW };
  },
}));

import { InstagramError } from '@/lib/instagram/errors';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as getStarters, PUT as putStarters } from './accounts/[id]/ice-breakers/route';
import { POST as convert } from './accounts/[id]/comment-rules/[ruleId]/convert/route';

const req = (path: string, method = 'GET', body?: unknown) =>
  new Request(`https://app.example.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const idCtx = (id = IG) => ({ params: Promise.resolve({ id }) });
const ruleCtx = (ruleId = RULE, id = IG) => ({ params: Promise.resolve({ id, ruleId }) });
const STARTERS = `/api/instagram/accounts/${IG}/ice-breakers`;
const CONVERT = `/api/instagram/accounts/${IG}/comment-rules/${RULE}/convert`;
const goodBody = { starters: [{ question: 'Hours?', flow_id: FLOW }] };

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('INSTAGRAM_ENABLED', '');
  Object.assign(h, { role: 'admin', signedIn: true, mutationOk: true, sessions: 0, calls: [], fail: null });
  __resetRateLimitForTests();
});

describe('while Instagram is off', () => {
  it('answers 503 instagram_not_enabled before the session', async () => {
    const responses = [
      await getStarters(req(STARTERS), idCtx()),
      await putStarters(req(STARTERS, 'PUT', goodBody), idCtx()),
      await convert(req(CONVERT, 'POST'), ruleCtx()),
    ];
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('instagram_not_enabled');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(h.sessions).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe('conversation starters', () => {
  beforeEach(enable);

  it('GET is open to any member of the workspace, scoped to the session account', async () => {
    h.role = 'viewer';
    const res = await getStarters(req(STARTERS), idCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.calls).toEqual([`get:${ACCOUNT}:viewer:${IG}`]);
  });

  it('GET refuses a signed-out caller and a malformed id', async () => {
    h.signedIn = false;
    expect((await getStarters(req(STARTERS), idCtx())).status).toBe(401);
    h.signedIn = true;
    const res = await getStarters(req('/api/instagram/accounts/x/ice-breakers'), idCtx('x'));
    expect(res.status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it('PUT needs Origin/CSRF proof and an admin', async () => {
    h.mutationOk = false;
    expect((await putStarters(req(STARTERS, 'PUT', goodBody), idCtx())).status).toBe(403);
    h.mutationOk = true;
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      const res = await putStarters(req(STARTERS, 'PUT', goodBody), idCtx());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('forbidden');
    }
    expect(h.calls).toEqual([]);
  });

  it('PUT refuses a body that is not a list of at most 4 { question, flow_id }', async () => {
    const bad = [
      null, {}, { starters: 'x' }, { starters: [{ question: 'a' }] }, { starters: [{ question: 'a', flow_id: FLOW, extra: 1 }] },
      { starters: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, flow_id: FLOW })) }, { ...goodBody, more: true },
    ];
    for (const body of bad) {
      const res = await putStarters(req(STARTERS, 'PUT', body), idCtx());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_request');
    }
    expect(h.calls).toEqual([]);
  });

  it('PUT passes the starters to the service for the session account', async () => {
    const res = await putStarters(req(STARTERS, 'PUT', goodBody), idCtx());
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([`set:${ACCOUNT}:${IG}:${JSON.stringify([{ question: 'Hours?', flowId: FLOW }])}`]);
  });

  it('PUT answers the service refusal with its fixed code, never Meta text', async () => {
    h.fail = new InstagramError('meta_error');
    const res = await putStarters(req(STARTERS, 'PUT', goodBody), idCtx());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'meta_error', message: expect.any(String) });
  });

  it('PUT is rate limited per user', async () => {
    let last = 200;
    for (let i = 0; i < 40 && last !== 429; i++) last = (await putStarters(req(STARTERS, 'PUT', goodBody), idCtx())).status;
    expect(last).toBe(429);
  });
});

describe('convert a comment rule to a flow', () => {
  beforeEach(enable);

  it('needs Origin/CSRF proof and an admin', async () => {
    h.mutationOk = false;
    expect((await convert(req(CONVERT, 'POST'), ruleCtx())).status).toBe(403);
    h.mutationOk = true;
    h.role = 'agent';
    expect((await convert(req(CONVERT, 'POST'), ruleCtx())).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('refuses malformed ids as not found', async () => {
    expect((await convert(req(CONVERT, 'POST'), ruleCtx('x'))).status).toBe(404);
    expect((await convert(req(CONVERT, 'POST'), ruleCtx(RULE, 'x'))).status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it('answers 201 with the new flow id', async () => {
    const res = await convert(req(CONVERT, 'POST'), ruleCtx());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ flow_id: FLOW });
    expect(h.calls).toEqual([`convert:${ACCOUNT}:${IG}:${RULE}`]);
  });

  it('answers another workspace’s rule as not found', async () => {
    h.fail = new InstagramError('not_found');
    const res = await convert(req(CONVERT, 'POST'), ruleCtx());
    expect(res.status).toBe(404);
  });
});
