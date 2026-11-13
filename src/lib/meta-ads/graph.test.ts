import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import {
  GRAPH_BASE,
  MetaGraphInputError,
  capiEvent,
  exchangeLoginToken,
  getGrantedScopes,
  getInsights,
  getOrCreateDataset,
  isMetaThrottle,
  isMetaTokenInvalid,
  listAdAccounts,
  listPages,
  metaErrorCode,
  postCapiEvents,
  subscribePageLeadgen,
  unsubscribePage,
} from './graph';

const TOKEN = 'EAAB-secret-token-value';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function call(index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url: new URL(url), init, headers: init.headers as Record<string, string> };
}

describe('graph client requests', () => {
  it('sends the token only in the Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'leads_retrieval', status: 'declined' }] }));
    await expect(getGrantedScopes(TOKEN)).resolves.toEqual(['ads_read']);
    const { url, headers, init } = call();
    expect(url.href.startsWith(`${GRAPH_BASE}/me/permissions`)).toBe(true);
    expect(url.href).not.toContain(TOKEN);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('follows after-cursors and validates ids', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ account_id: '111', name: 'Main', currency: 'INR', business: { id: '9' } }, { account_id: 'act_bad' }], paging: { cursors: { after: 'C1' }, next: 'https://graph.facebook.com/next?access_token=leak' } }))
      .mockResolvedValueOnce(json({ data: [{ account_id: '222', currency: 'inr' }] }));
    await expect(listAdAccounts(TOKEN)).resolves.toEqual([
      { id: '111', name: 'Main', currency: 'INR', businessId: '9' },
      { id: '222', name: null, currency: null, businessId: null },
    ]);
    expect(call(1).url.searchParams.get('after')).toBe('C1');
    expect(call(1).url.href).not.toContain('access_token');
  });

  it('returns Page tokens only for valid pages', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: '42', name: 'Shop', access_token: 'PAGE' }, { id: '43' }] }));
    await expect(listPages(TOKEN)).resolves.toEqual([{ id: '42', name: 'Shop', accessToken: 'PAGE' }]);
  });

  it('subscribes and unsubscribes the Page leadgen field', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true })).mockResolvedValueOnce(json({ success: true }));
    await subscribePageLeadgen('42', 'PAGE');
    expect(call(0).url.pathname.endsWith('/42/subscribed_apps')).toBe(true);
    expect(call(0).init.method).toBe('POST');
    expect(String(call(0).init.body)).toBe('subscribed_fields=leadgen');
    await unsubscribePage('42', 'PAGE');
    expect(call(1).init.method).toBe('DELETE');
  });

  it('refuses ids that could change the request path, before any call', async () => {
    await expect(subscribePageLeadgen('42/../me', 'PAGE')).rejects.toBeInstanceOf(MetaGraphInputError);
    await expect(getOrCreateDataset('1?x=1', TOKEN)).rejects.toBeInstanceOf(MetaGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps daily insights and the conversations-started action', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{
      campaign_id: '7', ad_id: '8', ad_name: 'Ad A', objective: 'OUTCOME_ENGAGEMENT', spend: '12.345', account_currency: 'INR',
      impressions: '1000', clicks: '25', date_start: '2026-11-01',
      actions: [{ action_type: 'link_click', value: '30' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '6' }],
    }] }));
    const rows = await getInsights('555', TOKEN, { level: 'ad', since: '2026-10-03', until: '2026-11-01' });
    expect(rows).toEqual([{ level: 'ad', objectId: '8', campaignId: '7', name: 'Ad A', objective: 'OUTCOME_ENGAGEMENT', day: '2026-11-01', spend: 12.35, currency: 'INR', impressions: 1000, clicks: 25, conversationsStarted: 6 }]);
    const { url } = call();
    expect(url.pathname.endsWith('/act_555/insights')).toBe(true);
    expect(url.searchParams.get('time_increment')).toBe('1');
    expect(JSON.parse(url.searchParams.get('time_range')!)).toEqual({ since: '2026-10-03', until: '2026-11-01' });
  });

  it('reuses an existing dataset and creates one only when missing', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: '777' }] }));
    await expect(getOrCreateDataset('123', TOKEN)).resolves.toBe('777');
    fetchMock.mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(json({ id: '778' }));
    await expect(getOrCreateDataset('123', TOKEN)).resolves.toBe('778');
    expect(call(2).init.method).toBe('POST');
  });

  it('posts a business-messaging CAPI event as JSON', async () => {
    fetchMock.mockResolvedValueOnce(json({ events_received: 1 }));
    const event = capiEvent({ eventName: 'Purchase', eventTime: new Date('2026-11-03T10:00:00Z'), eventId: 'order:o1:Purchase', wabaId: '1001', ctwaClid: 'CLID', value: 499, currency: 'INR' });
    await expect(postCapiEvents('777', TOKEN, [event])).resolves.toEqual({ eventsReceived: 1 });
    const { url, init, headers } = call();
    expect(url.pathname.endsWith('/777/events')).toBe(true);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ data: [{
      event_name: 'Purchase', event_time: 1793700000, event_id: 'order:o1:Purchase', action_source: 'business_messaging',
      messaging_channel: 'whatsapp', user_data: { whatsapp_business_account_id: '1001', ctwa_clid: 'CLID' }, custom_data: { value: 499, currency: 'INR' },
    }] });
  });
});

describe('Instagram CAPI payload (Stage 4C)', () => {
  it('keys an Instagram event by the account and the person, with no WhatsApp fields', () => {
    const event = capiEvent({ eventName: 'QualifiedLead', eventTime: new Date('2026-11-03T10:00:00Z'), eventId: 'flow:r:n:QualifiedLead',
      instagram: { accountId: '17841400000000000', igsid: '990011' }, value: 10, currency: 'USD' });
    expect(event).toEqual({
      event_name: 'QualifiedLead', event_time: 1793700000, event_id: 'flow:r:n:QualifiedLead', action_source: 'business_messaging',
      messaging_channel: 'instagram', user_data: { ig_account_id: '17841400000000000', ig_sid: '990011' }, custom_data: { value: 10, currency: 'USD' },
    });
  });

  it('refuses an id that is not a Meta numeric id', () => {
    expect(() => capiEvent({ eventName: 'LeadSubmitted', eventTime: new Date(), eventId: 'e', instagram: { accountId: '1', igsid: 'x/../y' } }))
      .toThrow(MetaGraphInputError);
  });
});

describe('graph client errors', () => {
  it('throws a MetaApiError with code, subcode and trace but without Meta\'s message', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: `Invalid token ${TOKEN} for user +919999999999`, code: 190, error_subcode: 463, fbtrace_id: 'TRACE', error_data: { details: 'secret details' } } }, 400));
    const error = await listPages(TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    const metaError = error as MetaApiError;
    expect(metaError.message).toBe('Meta API error: 400');
    expect(metaError.details).toBeNull();
    expect([metaError.code, metaError.subcode, metaError.fbtraceId, metaError.httpStatus]).toEqual([190, 463, 'TRACE', 400]);
    expect(JSON.stringify({ ...metaError, message: metaError.message, stack: metaError.stack })).not.toContain(TOKEN);
    expect(metaErrorCode(metaError)).toBe('190:463');
    expect(isMetaTokenInvalid(metaError)).toBe(true);
  });

  it('classifies throttling', () => {
    expect(isMetaThrottle(new MetaApiError('x', { httpStatus: 429 }))).toBe(true);
    expect(isMetaThrottle(new MetaApiError('x', { httpStatus: 400, code: 80004 }))).toBe(true);
    expect(isMetaThrottle(new MetaApiError('x', { httpStatus: 400, code: 100 }))).toBe(false);
    expect(isMetaThrottle(new Error('x'))).toBe(false);
    expect(metaErrorCode(new MetaApiError('x', { httpStatus: 400, code: 100 }))).toBe('100');
    expect(metaErrorCode(new Error('x'))).toBeNull();
  });

  it('accepts the login popup token only when Meta says it is a live user token of this app, then makes it long-lived', async () => {
    const config = { appId: '1', appSecret: 's' };
    fetchMock
      .mockResolvedValueOnce(json({ data: { is_valid: true, app_id: '1', type: 'USER' } }))
      .mockResolvedValueOnce(json({ access_token: 'LONG' }));
    await expect(exchangeLoginToken(config, 'SHORT')).resolves.toEqual({ accessToken: 'LONG' });
    const [debugUrl, debugInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(debugUrl).pathname).toMatch(/\/debug_token$/);
    expect(new URL(debugUrl).searchParams.get('input_token')).toBe('SHORT');
    // The app token travels in the header, never in the URL.
    expect((debugInit.headers as Record<string, string>).Authorization).toBe('Bearer 1|s');
    expect(debugUrl).not.toContain('1|s');
    const exchange = new URL(fetchMock.mock.calls[1][0] as string);
    expect(exchange.pathname).toMatch(/\/oauth\/access_token$/);
    expect(Object.fromEntries(exchange.searchParams)).toEqual({ grant_type: 'fb_exchange_token', client_id: '1', client_secret: 's', fb_exchange_token: 'SHORT' });
  });

  it("refuses another app's token, an invalid token or a non-user token as an invalid token, without exchanging it", async () => {
    const config = { appId: '1', appSecret: 's' };
    for (const data of [{ is_valid: true, app_id: '999', type: 'USER' }, { is_valid: false, app_id: '1' }, { is_valid: true, app_id: '1', type: 'PAGE' }]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(json({ data }));
      const error = await exchangeLoginToken(config, 'SHORT').catch((e: unknown) => e);
      expect(isMetaTokenInvalid(error)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('sanitizes a failed exchange', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: { is_valid: true, app_id: '1', type: 'USER' } }))
      .mockResolvedValueOnce(json({ error: { message: `token ${TOKEN} expired`, code: 100 } }, 400));
    const error = await exchangeLoginToken({ appId: '1', appSecret: 's' }, 'SHORT').catch((e: unknown) => e) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe('Meta API error: 400');
  });
});
