import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import {
  INSTAGRAM_GRAPH_VERSION,
  InstagramGraphInputError,
  buildAuthorizeUrl,
  exchangeCode,
  exchangeLongLived,
  getMe,
  isMetaThrottle,
  quickRepliesFit,
  refreshToken,
  sendAttachment,
  sendPrivateReply,
  sendQuickReplies,
  sendText,
  subscribe,
} from './graph';

vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op(h.tx) }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
const h = vi.hoisted(() => ({
  intents: new Map<string, string>(),
  tx: {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const key = values[1] as string;
      if (sql.includes('INSERT INTO outbound_intents')) {
        const status = h.intents.get(key);
        if (status === undefined || (status === 'failed' && values[2] === true)) { h.intents.set(key, 'dispatching'); return [{ id: key }]; }
        return [];
      }
      return [{ status: h.intents.get(values[1] as string), result: null }];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes("status='accepted'")) h.intents.set(values[1] as string, 'accepted');
      else h.intents.set(values[2] as string, values[0] as string);
      return 1;
    },
  },
}));

const TOKEN = 'IGAA-test-only-token';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  h.intents.clear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function call(index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url: new URL(url), init, headers: (init.headers ?? {}) as Record<string, string> };
}

describe('instagram graph client', () => {
  it('sends to graph.instagram.com with the token only in the Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(json({ recipient_id: '222', message_id: 'aWdfZAG1-test' }));
    await expect(sendText('111', TOKEN, '222', 'Hello')).resolves.toEqual({ messageId: 'aWdfZAG1-test', recipientId: '222' });
    const { url, headers, init } = call();
    expect(url.origin).toBe('https://graph.instagram.com');
    expect(url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/111/messages`);
    expect(url.search).toBe('');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ recipient: { id: '222' }, message: { text: 'Hello' } });
  });

  it('adds the Human Agent tag only when asked', async () => {
    fetchMock.mockResolvedValueOnce(json({ message_id: 'm1' }));
    await sendText('111', TOKEN, '222', 'Hi', { humanAgentTag: true });
    expect(JSON.parse(call().init.body as string)).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
  });

  it('checks ids and the 1000-byte text cap before any request', async () => {
    await expect(sendText('11a', TOKEN, '222', 'x')).rejects.toBeInstanceOf(InstagramGraphInputError);
    await expect(sendText('111', TOKEN, '../me', 'x')).rejects.toBeInstanceOf(InstagramGraphInputError);
    await expect(sendText('111', TOKEN, '222', 'é'.repeat(501))).rejects.toBeInstanceOf(InstagramGraphInputError);
    await expect(sendText('111', TOKEN, '222', '   ')).rejects.toBeInstanceOf(InstagramGraphInputError);
    await expect(sendAttachment('111', TOKEN, '222', { type: 'image', url: 'http://insecure.example.test/a.png' }))
      .rejects.toBeInstanceOf(InstagramGraphInputError);
    await expect(sendQuickReplies('111', TOKEN, '222', 'Pick', Array.from({ length: 14 }, (_, i) => ({ title: `t${i}`, payload: `p${i}` }))))
      .rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
    // 1000 bytes exactly is allowed.
    fetchMock.mockResolvedValueOnce(json({ message_id: 'm1' }));
    await expect(sendText('111', TOKEN, '222', 'é'.repeat(500))).resolves.toMatchObject({ messageId: 'm1' });
  });

  it('builds attachments, quick replies and private replies', async () => {
    fetchMock.mockImplementation(async () => json({ message_id: "m1" }));
    await sendAttachment('111', TOKEN, '222', { type: 'file', url: 'https://cdn.example.test/a.pdf' });
    await sendQuickReplies('111', TOKEN, '222', 'Pick one', [{ title: 'Yes', payload: 'yes' }]);
    await sendPrivateReply('111', TOKEN, '333', 'Thanks for your comment');
    expect(JSON.parse(call(0).init.body as string).message).toEqual({ attachment: { type: 'file', payload: { url: 'https://cdn.example.test/a.pdf' } } });
    expect(JSON.parse(call(1).init.body as string).message).toEqual({
      text: 'Pick one', quick_replies: [{ content_type: 'text', title: 'Yes', payload: 'yes' }],
    });
    expect(JSON.parse(call(2).init.body as string)).toEqual({ recipient: { comment_id: '333' }, message: { text: 'Thanks for your comment' } });
  });

  it('sanitises Meta errors to code/subcode/fbtrace and never keeps Meta text', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'secret detail about +15550001111', code: 10, error_subcode: 2534022, fbtrace_id: 'TRACE' } }, 400));
    const error = await sendText('111', TOKEN, '222', 'Hi').catch((e: unknown) => e) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe('Meta API error: 400');
    expect(error).toMatchObject({ code: 10, subcode: 2534022, fbtraceId: 'TRACE', httpStatus: 400, details: null });
    expect(JSON.stringify(error)).not.toContain('15550001111');
  });

  it('treats an accepted send without an id as an ambiguous (5xx) outcome', async () => {
    fetchMock.mockResolvedValueOnce(json({ recipient_id: '222' }));
    const error = await sendText('111', TOKEN, '222', 'Hi').catch((e: unknown) => e) as MetaApiError;
    expect(error.httpStatus).toBe(502);
  });

  it('a throttle is a rejected intent that retries only with retryRejected', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 4, message: 'Application request limit reached' } }, 429));
    const send = () => sendText('111', TOKEN, '222', 'Hi');
    const first = await dispatchOnce('acct', 'ig_send:1', send).catch((e: unknown) => e);
    expect(isMetaThrottle(first)).toBe(true);
    // A plain retry refuses (the intent is 'failed'); a throttle retry re-sends.
    await expect(dispatchOnce('acct', 'ig_send:1', send)).rejects.toThrow('reconciliation');
    fetchMock.mockResolvedValueOnce(json({ message_id: 'm2' }));
    await expect(dispatchOnce('acct', 'ig_send:1', send, { retryRejected: true })).resolves.toMatchObject({ messageId: 'm2' });
  });

  it('exchanges the code, then a long-lived token, and reads /me', async () => {
    const config = { appId: '123', appSecret: 'test-only-secret', redirectUri: 'https://app.example.test/api/instagram/callback' };
    fetchMock.mockResolvedValueOnce(json({ data: [{ access_token: 'short', user_id: 17841400000000000, permissions: 'instagram_business_basic,instagram_business_manage_messages' }] }));
    await expect(exchangeCode(config, 'CODE#_')).resolves.toEqual({
      accessToken: 'short', userId: '17841400000000000', scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    });
    const exchange = call(0);
    expect(exchange.url.href).toBe('https://api.instagram.com/oauth/access_token');
    expect(new URLSearchParams(exchange.init.body as string).get('code')).toBe('CODE');

    fetchMock.mockResolvedValueOnce(json({ access_token: 'long', expires_in: 5184000 }));
    await expect(exchangeLongLived(config, 'short')).resolves.toEqual({ accessToken: 'long', expiresInSeconds: 5184000 });
    expect(call(1).url.searchParams.get('grant_type')).toBe('ig_exchange_token');

    fetchMock.mockResolvedValueOnce(json({ access_token: 'long2', expires_in: 5184000 }));
    await refreshToken('long');
    expect(call(2).url.pathname).toBe('/refresh_access_token');

    fetchMock.mockResolvedValueOnce(json({ user_id: '17841400000000000', username: 'shop', name: 'Shop' }));
    await expect(getMe('long')).resolves.toEqual({ userId: '17841400000000000', username: 'shop', name: 'Shop' });
    expect(call(3).headers.Authorization).toBe('Bearer long');
  });

  it('subscribes the chosen fields and builds the authorize URL with the DM (and comment) scopes', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await subscribe('111', TOKEN, ['messages', 'messaging_postbacks', 'comments']);
    expect(call().url.searchParams.get('subscribed_fields')).toBe('messages,messaging_postbacks,comments');
    const url = new URL(buildAuthorizeUrl({ appId: '123', redirectUri: 'https://app.example.test/cb' }, { state: 'a'.repeat(32), comments: true }));
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments');
    expect(() => buildAuthorizeUrl({ appId: '123', redirectUri: 'https://x' }, { state: 'bad state' })).toThrow(InstagramGraphInputError);
  });

  it('checks quick replies against the limits', () => {
    expect(quickRepliesFit([{ title: 'Yes', payload: 'y' }])).toBe(true);
    expect(quickRepliesFit([])).toBe(false);
    expect(quickRepliesFit([{ title: 'x'.repeat(21), payload: 'y' }])).toBe(false);
  });
});
