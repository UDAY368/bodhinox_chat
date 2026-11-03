import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock('@/lib/meta-ads/leads', () => ({ persistPageWebhook: h.persist }));

import { GET, POST } from './route';

const SECRET = 'app-secret';
const env = { META_ADS_ENABLED: 'true', META_APP_ID: '1', META_APP_SECRET: SECRET, META_ADS_LOGIN_CONFIG_ID: '2', META_PAGE_WEBHOOK_VERIFY_TOKEN: 'verify-me' };
const enable = () => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const post = (body: string, signature: string | null = sign(body)) =>
  POST(new Request('http://localhost/api/meta/page-webhook', {
    method: 'POST', body, headers: signature ? { 'x-hub-signature-256': signature } : {},
  }));
const verify = (qs: string) => GET(new Request(`http://localhost/api/meta/page-webhook?${qs}`));
const PAGE = JSON.stringify({ object: 'page', entry: [{ id: '111', changes: [{ field: 'leadgen', value: { leadgen_id: '9', page_id: '111' } }] }] });

beforeEach(() => {
  vi.clearAllMocks();
  h.persist.mockResolvedValue('receipt-1');
});
afterEach(() => vi.unstubAllEnvs());

describe('GET verify', () => {
  it('echoes the challenge only for the configured token', async () => {
    enable();
    const ok = await verify('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('abc123');
    expect((await verify('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123')).status).toBe(403);
    expect((await verify('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=%3Cscript%3E')).status).toBe(403);
    expect((await verify(`hub.mode=subscribe&hub.verify_token=${'a'.repeat(513)}&hub.challenge=1`)).status).toBe(403);
  });

  it('refuses while the feature is off or the token is not set', async () => {
    enable();
    vi.stubEnv('META_PAGE_WEBHOOK_VERIFY_TOKEN', '');
    expect((await verify('hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status).toBe(403);
    enable();
    vi.stubEnv('META_ADS_ENABLED', '');
    expect((await verify('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1')).status).toBe(403);
  });
});

describe('POST', () => {
  it('rejects a bad signature before parsing, even while off', async () => {
    vi.stubEnv('META_APP_SECRET', SECRET);
    expect((await post(PAGE, 'sha256=00')).status).toBe(401);
    expect((await post(PAGE, null)).status).toBe(401);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('rejects payloads that are not Page webhooks', async () => {
    enable();
    const wa = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    expect((await post(wa)).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    const many = JSON.stringify({ object: 'page', entry: Array.from({ length: 101 }, () => ({ changes: [] })) });
    expect((await post(many)).status).toBe(400);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('acknowledges and stores nothing while the feature is off', async () => {
    vi.stubEnv('META_APP_SECRET', SECRET);
    const res = await post(PAGE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('persists a signed delivery, and asks Meta to retry when storage fails', async () => {
    enable();
    const res = await post(PAGE);
    expect(await res.json()).toEqual({ status: 'received', receipt_id: 'receipt-1' });
    expect(h.persist).toHaveBeenCalledWith(PAGE, JSON.parse(PAGE));
    h.persist.mockRejectedValueOnce(new Error('db down'));
    expect((await post(PAGE)).status).toBe(503);
  });

  it('caps the body at 2 MB', async () => {
    enable();
    const big = JSON.stringify({ object: 'page', entry: [], pad: 'x'.repeat(2 * 1024 * 1024) });
    expect((await post(big)).status).toBe(413);
    expect(h.persist).not.toHaveBeenCalled();
  });
});
