import { afterEach, expect, it, vi } from 'vitest';
import { exchangeEmbeddedSignupCode, getBusinessProfile, MetaApiError, updateBusinessProfile } from './meta-api';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
afterEach(() => vi.unstubAllGlobals());

it('exchanges the code with client id, secret and code', async () => {
  const fetch = vi.fn(async () => json({ access_token: 'T', token_type: 'bearer' }));
  vi.stubGlobal('fetch', fetch);
  expect(await exchangeEmbeddedSignupCode({ appId: '1', appSecret: 's', code: 'c' })).toEqual({ accessToken: 'T' });
  const url = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
  expect(url.pathname).toMatch(/\/oauth\/access_token$/);
  expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: '1', client_secret: 's', code: 'c' });
});

it('throws MetaApiError on a rejected code and on a missing token', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'expired', code: 100 } }, 400)));
  await expect(exchangeEmbeddedSignupCode({ appId: '1', appSecret: 's', code: 'c' })).rejects.toBeInstanceOf(MetaApiError);
  vi.stubGlobal('fetch', vi.fn(async () => json({})));
  await expect(exchangeEmbeddedSignupCode({ appId: '1', appSecret: 's', code: 'c' })).rejects.toThrow();
});

it('reads and writes the business profile', async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json({ success: true }) : json({ data: [{ about: 'A' }] })));
  vi.stubGlobal('fetch', fetch);
  expect(await getBusinessProfile({ phoneNumberId: '7', accessToken: 'T' })).toEqual({ about: 'A' });
  expect(fetch.mock.calls[0][0]).toContain('/7/whatsapp_business_profile?fields=');
  await updateBusinessProfile({ phoneNumberId: '7', accessToken: 'T', profile: { about: 'B', profile_picture_handle: 'H' } });
  const [url, init] = fetch.mock.calls[1];
  expect(url).toMatch(/\/7\/whatsapp_business_profile$/);
  expect(JSON.parse(init!.body as string)).toEqual({ messaging_product: 'whatsapp', about: 'B', profile_picture_handle: 'H' });
});
