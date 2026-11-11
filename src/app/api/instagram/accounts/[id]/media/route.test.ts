// Stage 2 (2D): GET /api/instagram/accounts/{id}/media, the flow builder's
// post picker. Off -> 503 before any session; then session, agent role, a
// well-formed id and a per-user rate limit, before the service (which checks
// the workspace under RLS; see media-picker.integration.test.ts). Failures are
// fixed codes, never Meta's text.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const IG = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({ role: 'agent', signedIn: true, sessions: 0, calls: [] as string[], fail: null as unknown }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {},
}));
vi.mock('@/lib/instagram/media-picker', () => ({
  listPickerMedia: async (actor: { accountId: string; userId: string; role: string }, id: string) => {
    if (h.fail) throw h.fail;
    h.calls.push(`media:${actor.accountId}:${actor.role}:${id}`);
    return [{ id: '17890001', caption: 'Sale', mediaType: 'IMAGE', previewUrl: null, permalink: null, timestamp: null }];
  },
}));

import { InstagramError } from '@/lib/instagram/errors';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const media = (id = IG) => GET(new Request(`https://app.example.test/api/instagram/accounts/${id}/media`), { params: Promise.resolve({ id }) });

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
  Object.assign(h, { role: 'agent', signedIn: true, sessions: 0, calls: [], fail: null });
  __resetRateLimitForTests();
});

describe('GET /api/instagram/accounts/{id}/media', () => {
  it('answers 503 while Instagram is off, before any session or Instagram work', async () => {
    const res = await media();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('instagram_not_enabled');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.sessions).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('needs a session and at least the agent role (anyone who edits flows)', async () => {
    enable();
    h.signedIn = false;
    expect((await media()).status).toBe(401);
    h.signedIn = true;
    h.role = 'viewer';
    const viewer = await media();
    expect(viewer.status).toBe(403);
    expect((await viewer.json()).error).toBe('forbidden');
    expect(h.calls).toEqual([]);
    for (const role of ['agent', 'admin', 'owner']) {
      h.role = role;
      expect((await media()).status).toBe(200);
    }
    expect(h.calls).toEqual([`media:${ACCOUNT}:agent:${IG}`, `media:${ACCOUNT}:admin:${IG}`, `media:${ACCOUNT}:owner:${IG}`]);
  });

  it('reads with the session workspace only, and refuses a malformed id before the service', async () => {
    enable();
    const ok = await media();
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect((await ok.json()).posts[0].id).toBe('17890001');
    expect(h.calls).toEqual([`media:${ACCOUNT}:agent:${IG}`]);
    const bad = await media('../../whatsapp');
    expect(bad.status).toBe(404);
    expect(h.calls).toHaveLength(1);
  });

  it('answers a foreign or missing account and Meta failures with fixed codes', async () => {
    enable();
    for (const [code, status] of [['not_found', 404], ['instagram_token_invalid', 409], ['instagram_account_disconnected', 409],
      ['rate_limited', 429], ['meta_error', 502]] as const) {
      h.fail = new InstagramError(code);
      const res = await media();
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(code);
    }
  });

  it('is rate limited per user', async () => {
    enable();
    for (let i = 0; i < 10; i++) expect((await media()).status).toBe(200);
    expect((await media()).status).toBe(429);
  });
});
