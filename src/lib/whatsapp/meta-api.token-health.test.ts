import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTokenError, MetaApiError, sendTemplateMessage, sendTextMessage, setSendTokenErrorReporter } from './meta-api';

// A send refused for its token (Meta 190 / HTTP 401) reports the sending number so its health is
// marked at once (health-sync.ts recordSendTokenError; the database side is in
// health-sync.integration.test.ts). Other errors do not, and the send's own error is unchanged.
const metaError = (status: number, code: number) => new Response(JSON.stringify({ error: { message: 'x', code } }), { status });

describe('[INB-01] token error on a WhatsApp send', () => {
  afterEach(() => { setSendTokenErrorReporter(null); vi.unstubAllGlobals(); });

  it('reports the sending number on 190 or 401 and still throws the Meta error', async () => {
    const reported: string[] = [];
    setSendTokenErrorReporter(async (id) => { reported.push(id); });
    vi.stubGlobal('fetch', vi.fn(async () => metaError(401, 190)));
    await expect(sendTextMessage({ phoneNumberId: '1234567890', accessToken: 't', to: '919800000201', text: 'hi' }))
      .rejects.toMatchObject({ name: 'MetaApiError', code: 190, httpStatus: 401 });
    vi.stubGlobal('fetch', vi.fn(async () => metaError(401, 0)));
    await expect(sendTemplateMessage({ phoneNumberId: '1234567891', accessToken: 't', to: '919800000201', templateName: 'hello', language: 'en' }))
      .rejects.toBeInstanceOf(MetaApiError);
    expect(reported).toEqual(['1234567890', '1234567891']);
  });

  it('does not report other rejections, and a failing reporter never changes the send error', async () => {
    const reporter = vi.fn(async () => { throw new Error('database down'); });
    setSendTokenErrorReporter(reporter);
    vi.stubGlobal('fetch', vi.fn(async () => metaError(400, 131047)));
    await expect(sendTextMessage({ phoneNumberId: '1234567890', accessToken: 't', to: '919800000201', text: 'hi' })).rejects.toMatchObject({ code: 131047 });
    expect(reporter).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => metaError(400, 190)));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sendTextMessage({ phoneNumberId: '1234567890', accessToken: 't', to: '919800000201', text: 'hi' })).rejects.toMatchObject({ code: 190 });
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(isTokenError(new MetaApiError('x', { httpStatus: 401 }))).toBe(true);
    expect(isTokenError(new MetaApiError('x', { httpStatus: 400, code: 100 }))).toBe(false);
  });
});
