import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { session, assertMutation, requirePermission, getMeetingConnection, setRegisterAttendees, disconnectZoom, startZoomConnect } = vi.hoisted(() => ({
  session: { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'owner' as string,
    sessionId: 's', expiresAt: 0, user: {} },
  assertMutation: vi.fn(async () => {}),
  requirePermission: vi.fn(async () => {}),
  getMeetingConnection: vi.fn(async () => ({ available: false, connected: false, status: null, register_attendees: false,
    last_error_code: null, connected_at: null })),
  setRegisterAttendees: vi.fn(),
  disconnectZoom: vi.fn(async () => {}),
  startZoomConnect: vi.fn(async () => ({ authorizeUrl: 'https://zoom.us/oauth/authorize?x=1', cookie: 'signed' })),
}));

vi.mock('@/lib/auth/session', () => ({ requireSession: vi.fn(async () => session), assertMutation }));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: vi.fn(), RATE_LIMITS: { adminAction: {} } }));
vi.mock('@/lib/meetings/connection', () => ({
  getMeetingConnection, setRegisterAttendees, disconnectZoom, startZoomConnect,
  ZOOM_OAUTH_COOKIE: 'bx_zoom_oauth', ZOOM_OAUTH_COOKIE_PATH: '/api/integrations/zoom', ZOOM_STATE_TTL_MS: 600_000,
}));

import { DELETE, GET, PATCH } from './route';
import { POST as CONNECT } from './connect/route';

const req = (method: string, body?: unknown) => new Request('http://localhost:3000/api/integrations/zoom', {
  method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' },
});
const ZOOM_ENV = { ZOOM_ENABLED: 'true', ZOOM_CLIENT_ID: 'cid', ZOOM_CLIENT_SECRET: 'sec', ZOOM_WEBHOOK_SECRET_TOKEN: 'wh' };

describe('/api/integrations/zoom', () => {
  beforeEach(() => { session.role = 'owner'; process.env.APP_URL = 'http://localhost:3000'; });
  afterEach(() => { for (const k of Object.keys(ZOOM_ENV)) delete process.env[k]; vi.clearAllMocks(); });

  it('reports not available to any member, uncached', async () => {
    session.role = 'viewer';
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, connected: false });
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('answers 503 not_configured to settings and connect without deployment config, before any session work', async () => {
    for (const res of [await PATCH(req('PATCH', { register_attendees: true })), await CONNECT(req('POST'))]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'not_configured' });
    }
    expect(assertMutation).not.toHaveBeenCalled();
    expect(startZoomConnect).not.toHaveBeenCalled();
  });

  it('requires an admin, the CSRF proof and the permission for mutations', async () => {
    Object.assign(process.env, ZOOM_ENV);
    session.role = 'agent';
    expect((await CONNECT(req('POST'))).status).toBe(403);
    expect((await DELETE(req('DELETE'))).status).toBe(403);
    expect(startZoomConnect).not.toHaveBeenCalled();
    expect(disconnectZoom).not.toHaveBeenCalled();
    session.role = 'admin';
    const res = await CONNECT(req('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://zoom.us/oauth/authorize?x=1' });
    expect(res.headers.get('set-cookie')).toMatch(/bx_zoom_oauth=signed;.*Path=\/api\/integrations\/zoom;.*HttpOnly/i);
    expect(assertMutation).toHaveBeenCalled();
    expect(requirePermission).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }), 'integrations.meetings');
  });

  it('validates the settings body and lets an admin disconnect without deployment config', async () => {
    Object.assign(process.env, ZOOM_ENV);
    expect((await PATCH(req('PATCH', { register_attendees: 'yes' }))).status).toBe(400);
    delete process.env.ZOOM_ENABLED;
    const res = await DELETE(req('DELETE'));
    expect(res.status).toBe(200);
    expect(disconnectZoom).toHaveBeenCalledWith(session.accountId, session.userId, 'admin');
  });
});
