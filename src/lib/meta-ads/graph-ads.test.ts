// The ads module's Graph calls (reporting and creation): request shapes per
// Meta's v27 guides, what is kept from responses, and that tokens stay in
// the Authorization header.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adSetForm, createCampaign, creativeSpec, findCreatedByName, GRAPH_BASE, getPlatformInsights, getReach, uploadAdImage,
  type AdSetInput, type CreativeInput,
} from './graph';

const TOKEN = 'EAAB-secret-token-value';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const call = (index = 0) => {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url: new URL(url), init, form: new URLSearchParams(String(init.body ?? '')) };
};

describe('reporting', () => {
  it('pins the ads API to a current Graph version', () => {
    expect(GRAPH_BASE).toBe('https://graph.facebook.com/v27.0');
  });

  it('splits campaign days by platform and folds unknown platforms into one row', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [
      { campaign_id: '7', date_start: '2026-11-01', publisher_platform: 'instagram', spend: '10.10', impressions: '500', clicks: '9', inline_link_clicks: '4',
        actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' }] },
      { campaign_id: '7', date_start: '2026-11-01', publisher_platform: 'oculus', spend: '1.00', impressions: '10', clicks: '0' },
      { campaign_id: '7', date_start: '2026-11-01', publisher_platform: 'mystery', spend: '2.05', impressions: '20', clicks: '1' },
      { campaign_id: 'x', date_start: '2026-11-01', publisher_platform: 'facebook' },
    ] }));
    const rows = await getPlatformInsights('555', TOKEN, { since: '2026-11-01', until: '2026-11-01' });
    expect(rows).toEqual([
      { campaignId: '7', day: '2026-11-01', platform: 'instagram', spend: 10.1, impressions: 500, clicks: 9, linkClicks: 4, conversationsStarted: 3, leads: 0 },
      { campaignId: '7', day: '2026-11-01', platform: 'unknown', spend: 3.05, impressions: 30, clicks: 1, linkClicks: 0, conversationsStarted: 0, leads: 0 },
    ]);
    const { url, init } = call();
    expect(url.searchParams.get('breakdowns')).toBe('publisher_platform');
    expect(url.searchParams.get('level')).toBe('campaign');
    expect(url.href).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reads reach per fixed range; account rows carry the ad account id', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ reach: '1200', frequency: '1.83333' }] }));
    await expect(getReach('555', TOKEN, 'account', 'last_30d')).resolves.toEqual([{ objectId: '555', reach: 1200, frequency: 1.8333 }]);
    expect(call().url.searchParams.get('date_preset')).toBe('last_30d');
    expect(call().url.searchParams.get('level')).toBe('account');
    fetchMock.mockResolvedValueOnce(json({ data: [{ adset_id: '15', reach: '40', frequency: 'oops' }, { adset_id: 'bad', reach: '1' }] }));
    await expect(getReach('555', TOKEN, 'adset', 'last_7d')).resolves.toEqual([{ objectId: '15', reach: 40, frequency: 0 }]);
  });
});

const adSet: AdSetInput = {
  name: 'Diwali · ad set', campaignId: '100', kind: 'whatsapp', pageId: '42', dailyBudgetMinor: 50000, startTime: '2026-11-20T00:00:00.000Z',
  endTime: null, countries: ['IN'], ageMin: 21, ageMax: 45, genders: [], whatsappNumber: '+919876543210', status: 'PAUSED',
};
const creative: CreativeInput = {
  name: 'Diwali · creative', kind: 'whatsapp', pageId: '42', instagramUserId: null, primaryText: 'Chat with us', headline: 'Offer',
  description: null, imageHash: 'abcdef0123456789abcdef0123456789', linkUrl: null, leadFormId: null, ctaType: 'WHATSAPP_MESSAGE', welcomeMessage: 'Hi!',
};

describe('ad creation request shapes', () => {
  it('makes a campaign with explicit no special category and ad set budgets', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: '100' }));
    await expect(createCampaign('555', TOKEN, { name: 'Diwali', kind: 'lead_form', status: 'PAUSED' })).resolves.toEqual({ id: '100' });
    const { url, init, form } = call();
    expect(url.pathname).toMatch(/\/act_555\/campaigns$/);
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(form)).toEqual({
      name: 'Diwali', objective: 'OUTCOME_LEADS', status: 'PAUSED', buying_type: 'AUCTION', special_ad_categories: '[]',
      is_adset_budget_sharing_enabled: 'false',
    });
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it('builds each kind of ad set: destination, goal, promoted object and the chosen audience', () => {
    const wa = adSetForm(adSet);
    expect(wa).toMatchObject({ destination_type: 'WHATSAPP', optimization_goal: 'CONVERSATIONS', billing_event: 'IMPRESSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP', daily_budget: '50000', status: 'PAUSED' });
    expect(JSON.parse(wa.promoted_object)).toEqual({ page_id: '42', whatsapp_phone_number: '+919876543210' });
    expect(JSON.parse(wa.targeting)).toEqual({ geo_locations: { countries: ['IN'] }, age_min: 21, age_max: 45, targeting_automation: { advantage_audience: 0 } });
    expect(wa).not.toHaveProperty('end_time');
    expect(adSetForm({ ...adSet, kind: 'instagram_direct' })).toMatchObject({ destination_type: 'INSTAGRAM_DIRECT', optimization_goal: 'CONVERSATIONS' });
    expect(JSON.parse(adSetForm({ ...adSet, kind: 'instagram_direct' }).promoted_object)).toEqual({ page_id: '42' });
    expect(adSetForm({ ...adSet, kind: 'lead_form' })).toMatchObject({ destination_type: 'ON_AD', optimization_goal: 'LEAD_GENERATION' });
    const web = adSetForm({ ...adSet, kind: 'website', genders: [2], endTime: '2026-12-01T00:00:00.000Z' });
    expect(web).toMatchObject({ destination_type: 'WEBSITE', optimization_goal: 'LINK_CLICKS', end_time: '2026-12-01T00:00:00.000Z' });
    expect(web).not.toHaveProperty('promoted_object');
    expect(JSON.parse(web.targeting).genders).toEqual([2]);
  });

  it('builds each kind of creative with its call to action', () => {
    const wa = creativeSpec(creative) as { page_id: string; link_data: Record<string, unknown> };
    expect(wa.page_id).toBe('42');
    expect(wa.link_data).toMatchObject({ message: 'Chat with us', name: 'Offer', image_hash: creative.imageHash, link: 'https://api.whatsapp.com/send',
      call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } });
    expect(wa.link_data.page_welcome_message).toMatchObject({ text_format: { message: { autofill_message: { content: 'Hi!' } } } });

    const ig = creativeSpec({ ...creative, kind: 'instagram_direct', instagramUserId: '9001', ctaType: 'INSTAGRAM_MESSAGE' }) as Record<string, unknown>;
    expect(ig.instagram_user_id).toBe('9001');
    expect((ig.link_data as Record<string, unknown>).call_to_action).toEqual({ type: 'INSTAGRAM_MESSAGE', value: { app_destination: 'INSTAGRAM_DIRECT' } });

    const lead = creativeSpec({ ...creative, kind: 'lead_form', leadFormId: '77', ctaType: 'SIGN_UP' }) as { link_data: Record<string, unknown> };
    expect(lead.link_data).toMatchObject({ link: 'http://fb.me/', call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '77' } } });

    const web = creativeSpec({ ...creative, kind: 'website', linkUrl: 'https://shop.example/', ctaType: 'SHOP_NOW' }) as { link_data: Record<string, unknown> };
    expect(web.link_data).toMatchObject({ link: 'https://shop.example/', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://shop.example/' } } });
    expect(web.link_data).not.toHaveProperty('page_welcome_message');
  });

  it('keeps only a hex image hash and an https URL from an upload', async () => {
    fetchMock.mockResolvedValueOnce(json({ images: { 'a.jpg': { hash: 'abcdef0123456789abcdef0123456789', url: 'https://scontent.example/a.jpg' } } }));
    await expect(uploadAdImage('555', TOKEN, 'QUJD', 'a.jpg')).resolves.toEqual({ hash: 'abcdef0123456789abcdef0123456789', url: 'https://scontent.example/a.jpg' });
    expect(call().form.get('bytes')).toBe('QUJD');
    fetchMock.mockResolvedValueOnce(json({ images: { 'a.jpg': { hash: '<script>', url: 'http://x' } } }));
    await expect(uploadAdImage('555', TOKEN, 'QUJD', 'a.jpg')).rejects.toThrow();
  });

  it('finds an object after an unclear create by exact name and creation time', async () => {
    const since = new Date('2026-11-20T10:00:00Z');
    fetchMock.mockResolvedValueOnce(json({ data: [
      { id: '1', name: 'Diwali', created_time: '2026-11-20T10:00:05+0000' },
      { id: '2', name: 'Diwali', created_time: '2026-11-19T10:00:00+0000' },
      { id: '3', name: 'Diwali 2', created_time: '2026-11-20T10:00:06+0000' },
    ] }));
    await expect(findCreatedByName('campaigns', '555', TOKEN, 'Diwali', since)).resolves.toEqual(['1']);
    expect(call().url.pathname).toMatch(/\/act_555\/campaigns$/);
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: '8', name: 'Diwali · ad set', created_time: '2026-11-20T10:01:00+0000' }] }));
    await expect(findCreatedByName('adsets', '100', TOKEN, 'Diwali · ad set', since)).resolves.toEqual(['8']);
    expect(call(1).url.pathname).toMatch(/\/100\/adsets$/);
  });
});
