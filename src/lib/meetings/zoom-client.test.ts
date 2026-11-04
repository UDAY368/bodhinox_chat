import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.mock('@/lib/jobs/lease', () => ({ leaseFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init) }));

import { zoomCall, ZoomError, zoomRevoke, zoomTokenRequest } from './zoom-client';

const config = { clientId: 'cid', clientSecret: 'secret', webhookSecretToken: 'wh' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ZoomError ? [e.kind, e.status, e.code] : e));

describe('zoomCall', () => {
  afterEach(() => { fetchMock.mockReset(); vi.restoreAllMocks(); });

  it('sends the bearer token to the fixed API base with a timeout and no redirects', async () => {
    fetchMock.mockResolvedValue(json(201, { id: 1 }));
    expect(await zoomCall('tok', 'POST', '/users/me/meetings', { topic: 'x' }, { type: 'scheduled' })).toEqual({ id: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.zoom.us/v2/users/me/meetings?type=scheduled');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: '{"topic":"x"}' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses paths that could leave the API base', async () => {
    for (const path of ['https://evil.example/x', '//evil.example', '/users/../admin', 'users/me'])
      await expect(zoomCall('tok', 'GET', path)).rejects.toThrow('Invalid Zoom path');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies failures and keeps only Zoom codes', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json(400, { code: 300, message: 'Invalid user alice@example.com' }));
    expect(await failure(zoomCall('t', 'POST', '/users/me/meetings', {}))).toEqual(['rejected', 400, '300']);
    fetchMock.mockResolvedValueOnce(json(401, { code: 124 }));
    expect(await failure(zoomCall('t', 'GET', '/users/me'))).toEqual(['auth', 401, '124']);
    fetchMock.mockResolvedValueOnce(json(429, {}));
    expect(await failure(zoomCall('t', 'GET', '/users/me'))).toEqual(['throttled', 429, null]);
    fetchMock.mockResolvedValueOnce(json(503, {}));
    expect(await failure(zoomCall('t', 'GET', '/users/me'))).toEqual(['unknown', 503, null]);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    expect(await failure(zoomCall('t', 'GET', '/users/me'))).toEqual(['unknown', null, 'timeout']);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await failure(zoomCall('t', 'GET', '/users/me'))).toEqual(['unknown', null, 'network']);
    // Nothing from a response body (here an email) reaches the log.
    expect(JSON.stringify(log.mock.calls)).not.toContain('alice@example.com');
  });

  it('reads 204 as success', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await zoomCall('t', 'DELETE', '/meetings/123')).toBeUndefined();
  });
});

describe('zoom OAuth', () => {
  afterEach(() => { fetchMock.mockReset(); vi.restoreAllMocks(); });

  it('exchanges with Basic client auth and reads the grant', async () => {
    fetchMock.mockResolvedValue(json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: 'meeting:write:admin user:read:admin' }));
    expect(await zoomTokenRequest(config, { grant_type: 'refresh_token', refresh_token: 'old' }))
      .toEqual({ accessToken: 'a', refreshToken: 'r', expiresInSeconds: 3599, scopes: ['meeting:write:admin', 'user:read:admin'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://zoom.us/oauth/token');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
    expect(String(init?.body)).toBe('grant_type=refresh_token&refresh_token=old');
  });

  it('treats invalid_grant as auth and an outage as unknown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json(400, { error: 'invalid_grant' }));
    expect(await failure(zoomTokenRequest(config, { grant_type: 'refresh_token', refresh_token: 'x' }))).toEqual(['auth', 400, 'invalid_grant']);
    fetchMock.mockResolvedValueOnce(json(502, {}));
    expect(await failure(zoomTokenRequest(config, { grant_type: 'refresh_token', refresh_token: 'x' }))).toEqual(['unknown', 502, null]);
    fetchMock.mockResolvedValueOnce(json(200, { access_token: 'a' }));
    expect(await failure(zoomTokenRequest(config, { grant_type: 'refresh_token', refresh_token: 'x' }))).toEqual(['unknown', 200, 'unreadable']);
  });

  it('never throws from revoke', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('down'));
    expect(await zoomRevoke(config, 'tok')).toBe(false);
    fetchMock.mockResolvedValueOnce(json(200, {}));
    expect(await zoomRevoke(config, 'tok')).toBe(true);
  });
});
