import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  secrets: null as null | Record<string, unknown>,
  stored: [] as unknown[],
  marked: [] as unknown[],
}));
vi.mock('./connection', () => ({
  loadCourierSecrets: async () => h.secrets,
  storeCourierToken: async (...args: unknown[]) => { h.stored.push(args); },
  markCourierAuthFailed: async (...args: unknown[]) => { h.marked.push(args); },
}));

import { shiprocketCall, shiprocketDisabled, ShiprocketError, shiprocketLogin, shiprocketRequest } from './shiprocket-client';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  h.stored = [];
  h.marked = [];
  h.secrets = {
    connectionId: 'c1', status: 'active', email: 'api@example.invalid', password: 'pw',
    token: 'cached-token-123456', tokenExpiresAt: new Date(Date.now() + 5 * 86_400_000),
  };
  delete process.env.SHIPROCKET_DISABLED;
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.SHIPROCKET_DISABLED; });

describe('shiprocketRequest', () => {
  it('classifies outcomes without leaking the provider message', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: 1 }));
    await expect(shiprocketRequest('t', 'GET', '/x')).resolves.toEqual({ ok: 1 });
    const cases: [Response | Error, string, string | null][] = [
      [json({}, 401), 'auth', 'auth'],
      [json({}, 429), 'throttled', 'throttled'],
      [json({ message: 'Order Id already exists for this channel' }, 422), 'rejected', 'duplicate_order'],
      [json({ message: 'Insufficient balance in wallet' }, 400), 'rejected', 'insufficient_balance'],
      [json({ message: 'secret detail' }, 400), 'rejected', 'http_400'],
      [json({}, 503), 'unknown', 'http_503'],
      [new TypeError('network down'), 'unknown', 'network'],
    ];
    for (const [reply, kind, code] of cases) {
      if (reply instanceof Error) fetchMock.mockRejectedValueOnce(reply); else fetchMock.mockResolvedValueOnce(reply);
      const error = (await shiprocketRequest('t', 'POST', '/x', {}).catch((e: unknown) => e)) as ShiprocketError;
      expect(error).toBeInstanceOf(ShiprocketError);
      expect({ kind: error.kind, code: error.code }).toEqual({ kind, code });
      expect(error.message).not.toContain('secret');
    }
  });

  it('calls only the Shiprocket API with a bearer token, a timeout and no redirects', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await shiprocketRequest('tok', 'POST', '/orders/create/adhoc', { a: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: '{"a":1}' });
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    await expect(shiprocketRequest('tok', 'GET', 'https://evil.example/x')).rejects.toMatchObject({ code: 'invalid' });
    await expect(shiprocketRequest('tok', 'GET', '/../x')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('does nothing while switched off', async () => {
    process.env.SHIPROCKET_DISABLED = 'true';
    expect(shiprocketDisabled()).toBe(true);
    await expect(shiprocketRequest('t', 'GET', '/x')).rejects.toMatchObject({ code: 'not_configured' });
    await expect(shiprocketCall(ACCOUNT, 'GET', '/x')).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shiprocketDisabled({ SHIPROCKET_DISABLED: 'false' })).toBe(false);
  });
});

describe('shiprocketLogin', () => {
  it('treats any refusal as bad credentials and validates the token', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Invalid email and password combination' }, 400));
    await expect(shiprocketLogin('a@b.c', 'x')).rejects.toMatchObject({ kind: 'auth' });
    fetchMock.mockResolvedValueOnce(json({ token: 'short' }));
    await expect(shiprocketLogin('a@b.c', 'x')).rejects.toMatchObject({ kind: 'unknown' });
    fetchMock.mockResolvedValueOnce(json({ token: 'a-long-enough-token' }));
    const login = await shiprocketLogin('a@b.c', 'x');
    expect(login.token).toBe('a-long-enough-token');
    expect(login.expiresAt.getTime()).toBeGreaterThan(Date.now() + 8 * 86_400_000);
  });
});

describe('shiprocketCall', () => {
  it('uses a fresh cached token without logging in', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: 1 }));
    await shiprocketCall(ACCOUNT, 'GET', '/x');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer cached-token-123456');
  });

  it('logs in when the token is about to expire, and once more after a 401', async () => {
    h.secrets!.tokenExpiresAt = new Date(Date.now() + 3_600_000);
    fetchMock
      .mockResolvedValueOnce(json({ token: 'fresh-token-1234567' }))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ token: 'fresh-token-7654321' }))
      .mockResolvedValueOnce(json({ ok: 2 }));
    await expect(shiprocketCall(ACCOUNT, 'GET', '/x')).resolves.toEqual({ ok: 2 });
    expect(h.stored).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a login that times out, answers 5xx or no token is "unavailable": the business call was never sent', async () => {
    h.secrets!.tokenExpiresAt = new Date(Date.now() + 3_600_000);
    for (const reply of [new TypeError('timeout'), json({}, 502), json({ token: 'short' })]) {
      fetchMock.mockReset();
      if (reply instanceof Error) fetchMock.mockRejectedValueOnce(reply); else fetchMock.mockResolvedValueOnce(reply);
      await expect(shiprocketCall(ACCOUNT, 'POST', '/orders/create/adhoc', {})).rejects.toMatchObject({ kind: 'unavailable' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/login$/);
    }
    // The re-login after a 401 too (the 401 was refused before anything happened).
    h.secrets!.tokenExpiresAt = new Date(Date.now() + 5 * 86_400_000);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}, 503));
    await expect(shiprocketCall(ACCOUNT, 'POST', '/courier/assign/awb', {})).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.marked).toEqual([]);
    // A business call that itself times out stays ambiguous.
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError('timeout'));
    await expect(shiprocketCall(ACCOUNT, 'POST', '/orders/create/adhoc', {})).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('marks the connection token_invalid when the stored user is refused, and refuses before HTTP afterwards', async () => {
    h.secrets!.token = null;
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await expect(shiprocketCall(ACCOUNT, 'GET', '/x')).rejects.toMatchObject({ kind: 'auth' });
    expect(h.marked).toEqual([[ACCOUNT, 'c1']]);
    fetchMock.mockClear();
    h.secrets!.status = 'token_invalid';
    await expect(shiprocketCall(ACCOUNT, 'GET', '/x')).rejects.toMatchObject({ kind: 'auth' });
    h.secrets = null;
    await expect(shiprocketCall(ACCOUNT, 'GET', '/x')).rejects.toMatchObject({ code: 'not_connected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
