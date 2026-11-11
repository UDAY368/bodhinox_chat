// Stage 4A graph client: calls for an account connected through a Facebook Page
// (graph.facebook.com, the Page token as the bearer) and the Facebook Page login
// calls. Built against Meta's documented Facebook Login / Page endpoints (the
// fixtures below) and needing a live capture before the feature ships; it stays
// behind INSTAGRAM_PAGE_LOGIN_ENABLED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { PAGE_LOGIN_SCOPES } from './config';
import {
  FACEBOOK_GRAPH_HOST,
  INSTAGRAM_GRAPH_HOST,
  INSTAGRAM_GRAPH_VERSION,
  InstagramGraphInputError,
  buildFacebookLoginUrl,
  exchangeFacebookCode,
  exchangeFacebookLongLived,
  listPagesWithInstagram,
  onConnection,
  sendText,
  subscribePage,
  unsubscribePage,
} from './graph';

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));

const PAGE_TOKEN = 'EAAG-test-only-page-token';
const USER_TOKEN = 'EAAG-test-only-user-token';
const CONFIG = { appId: '9876543210', appSecret: 'test-only-fb-secret', redirectUri: 'https://app.example.test/api/instagram/page-login/callback' };
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const call = (index = 0) => {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url: new URL(url), init, body: init.body ? JSON.parse(init.body as string) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('calls for an account by connection kind', () => {
  it('keeps graph.instagram.com by default and for instagram_login', async () => {
    fetchMock.mockImplementation(async () => json({ message_id: 'm1', recipient_id: '5' }));
    await sendText('111', 'IGAA-test-only-token', '5', 'Hi');
    await onConnection('instagram_login', () => sendText('111', 'IGAA-test-only-token', '5', 'Hi'));
    await onConnection(null, () => sendText('111', 'IGAA-test-only-token', '5', 'Hi'));
    for (const index of [0, 1, 2]) expect(call(index).url.origin).toBe(INSTAGRAM_GRAPH_HOST);
  });

  it('sends a facebook_page account through graph.facebook.com with the Page token in the header', async () => {
    fetchMock.mockImplementation(async () => json({ message_id: 'm1', recipient_id: '5' }));
    await onConnection('facebook_page', () => sendText('222', PAGE_TOKEN, '5', 'Hi'));
    const sent = call(0);
    expect(sent.url.origin).toBe(FACEBOOK_GRAPH_HOST);
    expect(sent.url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/222/messages`);
    expect(sent.url.toString()).not.toContain(PAGE_TOKEN);
    expect(sent.headers.Authorization).toBe(`Bearer ${PAGE_TOKEN}`);
  });

  it('does not leak the Page host to the calls after it, even concurrently', async () => {
    fetchMock.mockImplementation(async () => json({ message_id: 'm1', recipient_id: '5' }));
    await Promise.all([
      onConnection('facebook_page', async () => { await Promise.resolve(); await sendText('222', PAGE_TOKEN, '5', 'Hi'); }),
      sendText('111', 'IGAA-test-only-token', '5', 'Hi'),
    ]);
    await sendText('111', 'IGAA-test-only-token', '5', 'Hi');
    const origins = fetchMock.mock.calls.map(([url]) => new URL(url as string).origin).sort();
    expect(origins).toEqual([FACEBOOK_GRAPH_HOST, INSTAGRAM_GRAPH_HOST, INSTAGRAM_GRAPH_HOST]);
  });
});

describe('Facebook Page login', () => {
  const state = 'a'.repeat(32);

  it('builds the dialog URL with the Page scopes and refuses a weak state', () => {
    const url = new URL(buildFacebookLoginUrl(CONFIG, { state }));
    expect(url.origin + url.pathname).toBe(`https://www.facebook.com/${INSTAGRAM_GRAPH_VERSION}/dialog/oauth`);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.appId);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(PAGE_LOGIN_SCOPES.join(','));
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.toString()).not.toContain(CONFIG.appSecret);
    expect(() => buildFacebookLoginUrl(CONFIG, { state: 'short' })).toThrow(InstagramGraphInputError);
  });

  it('exchanges the code, then the short-lived token, with the query parameters Meta defines', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: USER_TOKEN, expires_in: 5000 }));
    expect(await exchangeFacebookCode(CONFIG, 'code-1')).toEqual({ accessToken: USER_TOKEN, expiresInSeconds: 5000 });
    const first = call(0);
    expect(first.url.origin + first.url.pathname).toBe(`${FACEBOOK_GRAPH_HOST}/${INSTAGRAM_GRAPH_VERSION}/oauth/access_token`);
    expect(first.url.searchParams.get('code')).toBe('code-1');
    expect(first.url.searchParams.get('client_secret')).toBe(CONFIG.appSecret);

    fetchMock.mockResolvedValueOnce(json({ access_token: 'EAAG-long', expires_in: 5184000 }));
    expect(await exchangeFacebookLongLived(CONFIG, USER_TOKEN)).toEqual({ accessToken: 'EAAG-long', expiresInSeconds: 5184000 });
    expect(call(1).url.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(call(1).url.searchParams.get('fb_exchange_token')).toBe(USER_TOKEN);

    await expect(exchangeFacebookCode(CONFIG, '')).rejects.toThrow(InstagramGraphInputError);
  });

  it('treats an exchange without a token as a 5xx and keeps Meta’s text out of the error', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(exchangeFacebookCode(CONFIG, 'code-1')).rejects.toMatchObject({ httpStatus: 502 });
    fetchMock.mockResolvedValueOnce(json({ error: { message: `Invalid token ${USER_TOKEN}`, code: 190 } }, 400));
    const error = await exchangeFacebookLongLived(CONFIG, USER_TOKEN).catch((e) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe('Meta API error: 400');
    expect(error.message).not.toContain(USER_TOKEN);
  });

  it('lists only the Pages that have a linked Instagram account and a Page token', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [
      { id: '100', name: 'Shop', access_token: PAGE_TOKEN, instagram_business_account: { id: '17841400000000001', username: 'shop' } },
      { id: 101, name: 'No Instagram', access_token: 'EAAG-x' },
      { id: '102', name: 'No token', instagram_business_account: { id: '17841400000000002' } },
      { id: 'abc', access_token: 'EAAG-y', instagram_business_account: { id: '1' } },
    ] }));
    expect(await listPagesWithInstagram(USER_TOKEN)).toEqual([
      { pageId: '100', pageName: 'Shop', pageToken: PAGE_TOKEN, instagramUserId: '17841400000000001', instagramUsername: 'shop' },
    ]);
    const sent = call(0);
    expect(sent.url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/me/accounts`);
    expect(sent.url.searchParams.get('fields')).toBe('id,name,access_token,instagram_business_account{id,username}');
    expect(sent.headers.Authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(sent.url.toString()).not.toContain(USER_TOKEN);
  });

  it('subscribes and unsubscribes a Page with the Page token in the header', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await subscribePage('100', PAGE_TOKEN, ['messages', 'messaging_postbacks', 'messages']);
    const sent = call(0);
    expect(sent.init.method).toBe('POST');
    expect(sent.url.origin).toBe(FACEBOOK_GRAPH_HOST);
    expect(sent.url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/100/subscribed_apps`);
    expect(sent.url.searchParams.get('subscribed_fields')).toBe('messages,messaging_postbacks');
    expect(sent.headers.Authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await unsubscribePage('100', PAGE_TOKEN);
    expect(call(1).init.method).toBe('DELETE');
    await expect(subscribePage('../x', PAGE_TOKEN, ['messages'])).rejects.toThrow(InstagramGraphInputError);
    await expect(subscribePage('100', PAGE_TOKEN, [])).rejects.toThrow(InstagramGraphInputError);
    fetchMock.mockResolvedValueOnce(json({ success: false }));
    await expect(subscribePage('100', PAGE_TOKEN, ['messages'])).rejects.toMatchObject({ httpStatus: 502 });
  });
});
