// Ads phases 3-5 (pure parts): cost caps, Messenger ads, the Page choice and
// "replace" on input, lead forms, saved setups, and engagement / website
// audience rules.
import { describe, expect, it } from 'vitest';
import { parseAdCreateInput, parseAdVariantInput, parseLeadFormInput } from './create';
import { adSetForm, creativeSpec, leadFormBody, ruleAudienceRule, type AdSetInput } from './graph';
import { parseAudienceCreateInput } from './audiences';
import { parseTemplateInput } from './templates';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const HASH = 'abcdef0123456789abcdef0123456789';
const base = { adAccountId: '555', kind: 'whatsapp', name: 'Ad', dailyBudgetMinor: 50000, countries: ['IN'], primaryText: 'Hi', imageHash: HASH };
const parse = (over: Record<string, unknown> = {}) => parseAdCreateInput({ ...base, ...over }, NOW);
const adSet = (over: Partial<AdSetInput> = {}) => adSetForm({
  name: 'S', campaignId: '1', kind: 'whatsapp', pageId: '2', dailyBudgetMinor: 50000, startTime: 'x', endTime: null,
  countries: ['IN'], ageMin: 18, ageMax: 65, genders: [], whatsappNumber: null, status: 'PAUSED', ...over,
});

describe('cost cap', () => {
  it('is optional, above zero and no higher than the daily budget', () => {
    expect(parse()).toMatchObject({ bidCapMinor: null });
    expect(parse({ bidCapMinor: 2500 })).toMatchObject({ bidCapMinor: 2500 });
    for (const bad of [0, -1, 1.5, 50001, '2500']) expect(parse({ bidCapMinor: bad })).toBeNull();
  });

  it('becomes a COST_CAP bid on the ad set; none keeps the lowest cost', () => {
    expect(adSet()).toMatchObject({ bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
    expect(adSet()).not.toHaveProperty('bid_amount');
    expect(adSet({ bidCapMinor: 2500 })).toMatchObject({ bid_strategy: 'COST_CAP', bid_amount: '2500' });
  });
});

describe('Messenger ads and the Page', () => {
  it('a Messenger ad sends people to the Page on Messenger', () => {
    expect(parse({ kind: 'messenger' })).toMatchObject({ kind: 'messenger', ctaType: 'MESSAGE_PAGE' });
    expect(adSet({ kind: 'messenger' })).toMatchObject({ destination_type: 'MESSENGER', optimization_goal: 'CONVERSATIONS' });
    const spec = creativeSpec({ name: 'C', kind: 'messenger', pageId: '2', instagramUserId: null, primaryText: 'Hi', headline: null,
      description: null, imageHash: HASH, linkUrl: null, leadFormId: null, ctaType: 'MESSAGE_PAGE', welcomeMessage: null });
    expect(JSON.stringify(spec)).toContain('"type":"MESSAGE_PAGE"');
    expect(parse({ kind: 'messenger', placements: ['whatsapp_status'] })).toBeNull();
  });

  it('a chosen Page is a Meta id; replace is only ever an explicit true', () => {
    expect(parse({ pageId: '777' })).toMatchObject({ pageId: '777' });
    expect(parse({ pageId: '' })).toMatchObject({ pageId: null });
    expect(parse({ pageId: 'me' })).toBeNull();
    const variant = { sourceId: '33333333-3333-4333-8333-333333333333', primaryText: 'New', imageHash: HASH };
    expect(parseAdVariantInput(variant)).toMatchObject({ replace: false });
    expect(parseAdVariantInput({ ...variant, replace: true })).toMatchObject({ replace: true });
    expect(parseAdVariantInput({ ...variant, replace: 'yes' })).toMatchObject({ replace: false });
  });
});

describe('lead form builder', () => {
  const form = { name: 'Offer', questions: ['FULL_NAME', 'PHONE'], privacyUrl: 'https://shop.example/privacy' };
  it('needs a phone or an email, an https privacy policy and known questions', () => {
    expect(parseLeadFormInput(form)).toMatchObject({ name: 'Offer', questions: ['FULL_NAME', 'PHONE'], customQuestions: [], websiteUrl: null });
    expect(parseLeadFormInput({ ...form, questions: ['FULL_NAME', 'CITY'] })).toBeNull();
    expect(parseLeadFormInput({ ...form, questions: ['PHONE', 'SSN'] })).toBeNull();
    expect(parseLeadFormInput({ ...form, privacyUrl: 'http://shop.example/privacy' })).toBeNull();
    expect(parseLeadFormInput({ ...form, customQuestions: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBeNull();
    expect(parseLeadFormInput({ ...form, customQuestions: [''] })).toBeNull();
  });

  it("builds Meta's form body with custom questions after the standard ones", () => {
    const body = leadFormBody(parseLeadFormInput({ ...form, customQuestions: ['Which product?'], websiteUrl: 'https://shop.example' })!);
    expect(JSON.parse(body.questions)).toEqual([{ type: 'FULL_NAME' }, { type: 'PHONE' }, { type: 'CUSTOM', key: 'question_1', label: 'Which product?' }]);
    expect(JSON.parse(body.privacy_policy)).toEqual({ url: 'https://shop.example/privacy', link_text: 'Privacy policy' });
    expect(JSON.parse(body.thank_you_page)).toMatchObject({ button_type: 'VIEW_WEBSITE', website_url: 'https://shop.example/' });
  });
});

describe('engagement and website audiences', () => {
  const common = { action: 'create', adAccountId: '555', name: 'Engaged' };
  it('parses the source and a 1-365 day window', () => {
    expect(parseAudienceCreateInput({ ...common, kind: 'engagement', source: 'instagram', retentionDays: 90 }))
      .toEqual({ kind: 'engagement', adAccountId: '555', name: 'Engaged', source: 'instagram', retentionDays: 90 });
    expect(parseAudienceCreateInput({ ...common, kind: 'website', pixelId: '123', retentionDays: 30 })).toMatchObject({ pixelId: '123' });
    expect(parseAudienceCreateInput({ ...common, kind: 'engagement', source: 'tiktok', retentionDays: 30 })).toBeNull();
    expect(parseAudienceCreateInput({ ...common, kind: 'website', pixelId: 'abc', retentionDays: 30 })).toBeNull();
    expect(parseAudienceCreateInput({ ...common, kind: 'engagement', source: 'page', retentionDays: 400 })).toBeNull();
  });

  it("writes Meta's rule for Page, Instagram and pixel audiences", () => {
    const rule = (type: 'page' | 'instagram' | 'pixel') => (ruleAudienceRule({ type, id: '42' }, 30) as {
      inclusions: { rules: { event_sources: { id: string; type: string }[]; retention_seconds: number; filter: { filters: { field: string; value: string }[] } }[] } }).inclusions.rules[0];
    expect(rule('page')).toMatchObject({ event_sources: [{ id: '42', type: 'page' }], retention_seconds: 2_592_000 });
    expect(rule('page').filter.filters[0]).toMatchObject({ field: 'event', value: 'page_engaged' });
    expect(rule('instagram').event_sources[0].type).toBe('ig_business');
    expect(rule('pixel').filter.filters[0]).toMatchObject({ field: 'url', value: '' });
    expect(() => ruleAudienceRule({ type: 'page', id: '../x' }, 30)).toThrow();
  });
});

describe('saved setups', () => {
  it('keeps a named object of at most 16 KB', () => {
    expect(parseTemplateInput({ name: '  Diwali   offer ', settings: { kind: 'whatsapp' } })).toEqual({ name: 'Diwali offer', settings: { kind: 'whatsapp' } });
    expect(parseTemplateInput({ name: '', settings: {} })).toBeNull();
    expect(parseTemplateInput({ name: 'x', settings: [] })).toBeNull();
    expect(parseTemplateInput({ name: 'x', settings: { text: 'a'.repeat(17_000) } })).toBeNull();
  });
});
