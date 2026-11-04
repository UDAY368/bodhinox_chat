import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock('@/lib/instagram/webhook', () => ({ persistInstagramWebhook: h.persist }));

import { GET, POST } from './route';

const IG_SECRET = 'ig-app-secret';
const META_SECRET = 'meta-app-secret';
const env = {
  INSTAGRAM_ENABLED: 'true',
  INSTAGRAM_APP_ID: '123',
  INSTAGRAM_APP_SECRET: IG_SECRET,
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'verify-me',
  APP_URL: 'https://app.example.test',
  META_APP_SECRET: META_SECRET,
};
const enable = () => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };
const disable = () => { for (const k of Object.keys(env)) vi.stubEnv(k, ''); };
const sign = (body: string, secret = IG_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const post = (body: string, signature: string | null = sign(body)) =>
  POST(new Request('http://localhost/api/meta/instagram-webhook', {
    method: 'POST', body, headers: signature ? { 'x-hub-signature-256': signature } : {},
  }));
const verify = (qs: string) => GET(new Request(`http://localhost/api/meta/instagram-webhook?${qs}`));
const IG = JSON.stringify({
  object: 'instagram',
  entry: [{ id: '178400000000001', time: 1, messaging: [{ sender: { id: '9001' }, recipient: { id: '178400000000001' }, timestamp: 1, message: { mid: 'm1', text: 'private-dm-text' } }] }],
});

beforeEach(() => {
  vi.clearAllMocks();
  disable();
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
    expect((await verify('hub.mode=unsubscribe&hub.verify_token=verify-me&hub.challenge=abc123')).status).toBe(403);
    expect((await verify('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=%3Cscript%3E')).status).toBe(403);
    expect((await verify(`hub.mode=subscribe&hub.verify_token=${'a'.repeat(513)}&hub.challenge=1`)).status).toBe(403);
  });

  it('refuses while Instagram is off or not configured', async () => {
    expect((await verify('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1')).status).toBe(403);
    enable();
    vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', '');
    expect((await verify('hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status).toBe(403);
  });
});

describe('POST', () => {
  it('rejects a missing or bad signature before parsing, even while off', async () => {
    vi.stubEnv('INSTAGRAM_APP_SECRET', IG_SECRET);
    expect((await post(IG, 'sha256=00')).status).toBe(401);
    expect((await post(IG, null)).status).toBe(401);
    expect((await post(IG, sign(IG, 'someone-else'))).status).toBe(401);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('accepts a signature made with the Instagram app secret or META_APP_SECRET', async () => {
    enable();
    expect((await post(IG, sign(IG, IG_SECRET))).status).toBe(200);
    expect((await post(IG, sign(IG, META_SECRET))).status).toBe(200);
    expect(h.persist).toHaveBeenCalledTimes(2);
  });

  it('rejects payloads that are not Instagram webhooks or are too large in item count', async () => {
    enable();
    const wa = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    expect((await post(wa)).status).toBe(400);
    const page = JSON.stringify({ object: 'page', entry: [] });
    expect((await post(page)).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    const manyEntries = JSON.stringify({ object: 'instagram', entry: Array.from({ length: 101 }, () => ({ messaging: [] })) });
    expect((await post(manyEntries)).status).toBe(400);
    const manyEvents = JSON.stringify({ object: 'instagram', entry: [{ id: '1', messaging: Array.from({ length: 101 }, () => ({})) }] });
    expect((await post(manyEvents)).status).toBe(400);
    const manyChanges = JSON.stringify({ object: 'instagram', entry: [{ id: '1', changes: Array.from({ length: 101 }, () => ({})) }] });
    expect((await post(manyChanges)).status).toBe(400);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('acknowledges a signed delivery and stores nothing while Instagram is off', async () => {
    vi.stubEnv('INSTAGRAM_APP_SECRET', IG_SECRET);
    const res = await post(IG);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('persists a signed delivery, and asks Meta to retry when storage fails', async () => {
    enable();
    const res = await post(IG);
    expect(await res.json()).toEqual({ status: 'received', receipt_id: 'receipt-1' });
    expect(h.persist).toHaveBeenCalledWith(IG, JSON.parse(IG));
    h.persist.mockRejectedValueOnce(new Error('db down'));
    expect((await post(IG)).status).toBe(503);
  });

  it('caps the body at 2 MB and refuses an empty body', async () => {
    enable();
    const big = JSON.stringify({ object: 'instagram', entry: [], pad: 'x'.repeat(2 * 1024 * 1024) });
    expect((await post(big)).status).toBe(413);
    expect((await post('', null)).status).toBe(400);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('never logs the body', async () => {
    enable();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.persist.mockRejectedValueOnce(new Error('db down'));
    await post(IG);
    for (const spy of [log, warn, error])
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('private-dm-text');
    log.mockRestore(); warn.mockRestore(); error.mockRestore();
  });
});
