import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureFetch, loadProviderFixture } from '@/test/fixtures/providers';
import { MetaApiError, sendMediaMessage, sendTemplateMessage, sendTextMessage, submitMessageTemplate } from './meta-api';
import { explainMetaError } from './meta-error-explain';
import { categorizeHealthError } from './health-sync';
import { THROTTLE_CODES } from './broadcast-core';

// Outbound contract (design 1.4, P1): docs-derived Cloud API responses replayed
// through the real client. These pin our request shape and our reading of the
// documented responses; they are not verified against Meta.
const fx = (name: string) => loadProviderFixture('whatsapp', name);
const ARGS = { phoneNumberId: '106540352242922', accessToken: 'test-only-token', to: '919800000201' };

function stub(...names: string[]) {
  const fetch = fixtureFetch(names.map(fx));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** The request matches the documented one: method, path shape, auth header and every required field. */
function expectRequest(call: { url: string; method: string; headers: Record<string, string>; body: unknown }, name: string) {
  const req = fx(name).request!;
  expect(call.method).toBe(req.method);
  const pattern = new RegExp(`^https://graph\\.facebook\\.com${req.path.replace('{version}', 'v\\d+\\.\\d+').replace(/\{[a-z-]+\}/g, '[0-9]+')}$`);
  expect(call.url).toMatch(pattern);
  expect(call.headers.authorization).toBe('Bearer test-only-token');
  expect(call.body).toMatchObject(req.body as object);
}

describe('[WA-01] [WA-04] WhatsApp Cloud API outbound contract (docs-derived)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a text message as documented and reads the wamid', async () => {
    const fetch = stub('send-text');
    expect(await sendTextMessage({ ...ARGS, text: 'Hello' })).toEqual({ messageId: (fx('send-text').response.body as { messages: { id: string }[] }).messages[0].id });
    expectRequest(fetch.calls[0], 'send-text');
  });

  it('sends a template with body parameters as documented', async () => {
    const fetch = stub('send-template');
    const result = await sendTemplateMessage({ ...ARGS, templateName: 'order_update', language: 'en', params: ['#1001'] });
    expect(result.messageId).toMatch(/^wamid\./);
    expectRequest(fetch.calls[0], 'send-template');
  });

  it('sends an image by link with its caption as documented', async () => {
    const fetch = stub('send-media-image');
    const result = await sendMediaMessage({ ...ARGS, kind: 'image', link: 'https://cdn.example.com/catalog.jpg', caption: 'Catalog' });
    expect(result.messageId).toMatch(/^wamid\./);
    expectRequest(fetch.calls[0], 'send-media-image');
  });

  it('submits a template for review and reads its id and status', async () => {
    const fetch = stub('template-create');
    const req = fx('template-create').request!.body as Parameters<typeof submitMessageTemplate>[0]['payload'];
    expect(await submitMessageTemplate({ wabaId: '102290129340398', accessToken: 'test-only-token', payload: req }))
      .toEqual({ id: '594425479261596', status: 'PENDING', category: 'UTILITY' });
    expectRequest(fetch.calls[0], 'template-create');
  });

  it.each([
    ['error-190-token', 401, 190, 463],
    ['error-131047-reengagement', 400, 131047, null],
    ['error-132001-template-missing', 404, 132001, null],
    ['error-368-policy', 400, 368, null],
    ['error-80007-rate-limit', 429, 80007, null],
  ])('reads %s into a classified MetaApiError and never a generic one', async (name, status, code, subcode) => {
    stub(name as string);
    const error = await sendTextMessage({ ...ARGS, text: 'Hello' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ httpStatus: status, code, subcode, fbtraceId: 'AFixtureTraceId000001' });
    expect((error as MetaApiError).details).toBeTruthy();
  });

  it('classifies a revoked token as a token problem and a rate limit as throttling', async () => {
    stub('error-190-token');
    const token = (await sendTextMessage({ ...ARGS, text: 'x' }).catch((e: unknown) => e)) as MetaApiError;
    expect(categorizeHealthError(token)).toBe('token');
    expect(explainMetaError(token, 'verify_number').field).toBe('access_token');
    stub('error-80007-rate-limit');
    const limited = (await sendTextMessage({ ...ARGS, text: 'x' }).catch((e: unknown) => e)) as MetaApiError;
    expect(THROTTLE_CODES.has(limited.code!)).toBe(true);
    expect(categorizeHealthError(limited)).toBe('unavailable');
  });
});
