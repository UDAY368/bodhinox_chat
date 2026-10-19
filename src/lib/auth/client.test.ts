import { afterEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', {
  location: { origin: 'https://crm.test', protocol: 'https:' },
});
vi.stubGlobal('document', { cookie: 'bnx_csrf=test-csrf' });
vi.stubGlobal('navigator', {});
vi.stubGlobal('BroadcastChannel', undefined);
import { authFetch, createAuthClient } from './client';
afterEach(() => {
  vi.restoreAllMocks();
});
describe('browser cookie auth', () => {
  it('keeps multipart file bytes and their boundary together', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      const form = await request.formData();
      const file = form.get('file') as File;
      expect(await file.text()).toBe('upload-test');
      expect(form.get('bucket')).toBe('avatars');
      return Response.json({ ok: true });
    }));
    const form = new FormData();
    form.set('bucket', 'avatars');
    form.set('file', new File(['upload-test'], 'test.png', { type: 'image/png' }));
    await expect(authFetch('/api/media/object', { method: 'POST', body: form })).resolves.toHaveProperty('status', 200);
  });
  it('never attaches credentials or CSRF material to another origin', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await expect(
      authFetch('https://evil.test/api', { method: 'POST' })
    ).rejects.toThrow('same origin');
    expect(network).not.toHaveBeenCalled();
  });
  it('replays multipart bytes intact after session refresh', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => {
      if (!(input instanceof Request)) return Response.json({ session: { accountId: 'tenant' } });
      const file = (await input.formData()).get('file') as File;
      expect(await file.text()).toBe('retry-upload');
      return Response.json({}, { status: ++attempts === 1 ? 401 : 200 });
    }));
    const form = new FormData();
    form.set('file', new File(['retry-upload'], 'test.pdf', { type: 'application/pdf' }));
    expect((await authFetch('/api/media/object', { method: 'POST', body: form })).status).toBe(200);
    expect(attempts).toBe(2);
  });
  it('injects CSRF on mutations and sends cookie credentials', async () => {
    const network = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', network);
    await authFetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const request = network.mock.calls[0][0] as Request;
    expect(request.credentials).toBe('same-origin');
    expect(request.headers.get('x-csrf-token')).toBe('test-csrf');
    expect(request.headers.get('authorization')).toBeNull();
  });
  it("publishes only the server's public session without a bearer JWT", async () => {
    const session = {
      user: {
        id: 'user',
        email: 'user@test.invalid',
        user_metadata: { full_name: 'User' },
      },
      expires_at: 1,
      accountId: 'tenant',
      role: 'owner',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ session }))
    );
    const result = await createAuthClient().getSession();
    expect(result.data.session).toEqual(session);
    expect(result.data.session).not.toHaveProperty('access_token');
  });
  it('serializes concurrent rejected requests to one refresh', async () => {
    let authenticated = false,
      refreshes = 0;
    const session = {
      user: {
        id: 'user',
        email: 'user@test.invalid',
        user_metadata: { full_name: 'User' },
      },
      expires_at: 1,
      accountId: 'tenant',
      role: 'owner',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string) => {
        const url =
          input instanceof Request
            ? input.url
            : new URL(input, 'https://crm.test').href;
        if (url.endsWith('/session'))
          return authenticated
            ? Response.json({ session })
            : Response.json({ session: null }, { status: 401 });
        if (url.endsWith('/refresh')) {
          refreshes++;
          authenticated = true;
          return Response.json({ ok: true });
        }
        return Response.json(
          { ok: authenticated },
          { status: authenticated ? 200 : 401 }
        );
      })
    );
    const responses = await Promise.all([
      authFetch('/api/contacts'),
      authFetch('/api/tags'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(refreshes).toBe(1);
  });
});
