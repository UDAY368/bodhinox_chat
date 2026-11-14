// Ads gaps, phases 2-3: placements (incl. WhatsApp Status), targeting search
// choices, video and carousel creatives, review feedback, and rule maths.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAdVideo, parseAdCreateInput, parseAdVariantInput } from './create';
import { adSetForm, creativeSpec, placementTargeting, reviewFeedbackOf, searchTargeting, type AdSetInput, type CreativeInput } from './graph';
import { parseAdRuleInput, ruleMatches, ruleValue } from './rules';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const HASH = 'abcdef0123456789abcdef0123456789';
const base = { adAccountId: '555', kind: 'whatsapp', name: 'Ad', dailyBudgetMinor: 50000, countries: ['IN'], primaryText: 'Hi', imageHash: HASH };
const parse = (over: Record<string, unknown> = {}) => parseAdCreateInput({ ...base, ...over }, NOW);
const adSet = (over: Partial<AdSetInput> = {}): Record<string, unknown> => JSON.parse(adSetForm({
  name: 'S', campaignId: '1', kind: 'whatsapp', pageId: '2', dailyBudgetMinor: 100, startTime: 'x', endTime: null,
  countries: ['IN', 'US'], ageMin: 18, ageMax: 65, genders: [], whatsappNumber: null, status: 'PAUSED', ...over,
}).targeting);
const creative = (over: Partial<CreativeInput> = {}) => creativeSpec({
  name: 'C', kind: 'whatsapp', pageId: '2', instagramUserId: null, primaryText: 'Hi', headline: 'H', description: null, imageHash: HASH,
  linkUrl: null, leadFormId: null, ctaType: 'WHATSAPP_MESSAGE', welcomeMessage: null, ...over,
});

describe('placements', () => {
  it('none is automatic; Messenger and Audience Network bring Facebook along', () => {
    expect(placementTargeting([])).toEqual({});
    expect(placementTargeting(['instagram'])).toEqual({ publisher_platforms: ['instagram'] });
    expect(new Set(placementTargeting(['messenger', 'audience_network']).publisher_platforms as string[]))
      .toEqual(new Set(['messenger', 'audience_network', 'facebook']));
  });

  it('WhatsApp Status adds the Instagram Stories position Meta requires, unless Instagram is already chosen', () => {
    expect(placementTargeting(['whatsapp_status'])).toEqual({
      publisher_platforms: ['whatsapp', 'instagram'], whatsapp_positions: ['status'], instagram_positions: ['story'],
    });
    const both = placementTargeting(['instagram', 'whatsapp_status']);
    expect(both.instagram_positions).toBeUndefined();
    expect(both.whatsapp_positions).toEqual(['status']);
  });
});

describe('targeting', () => {
  it('a country with a chosen city or region is narrowed to it; interests and languages are added', () => {
    const t = adSet({
      places: [{ type: 'city', key: '2295424', name: 'Mumbai', countryCode: 'IN' }, { type: 'region', key: '1729', name: 'Goa', countryCode: 'IN' }],
      interests: [{ id: '6003107902433', name: 'Yoga' }], locales: [6, 24],
    });
    expect(t.geo_locations).toEqual({
      countries: ['US'], regions: [{ key: '1729' }], cities: [{ key: '2295424', radius: 25, distance_unit: 'kilometer' }],
    });
    expect(t.flexible_spec).toEqual([{ interests: [{ id: '6003107902433', name: 'Yoga' }] }]);
    expect(t.locales).toEqual([6, 24]);
  });

  it('refuses a malformed place key before any call', () => {
    expect(() => adSet({ places: [{ type: 'city', key: '1 OR 1', name: 'x', countryCode: null }] })).toThrow();
  });
});

describe('creatives', () => {
  it('a video ad sends video_data with its thumbnail and a WhatsApp button that carries its link', () => {
    const spec = creative({ format: 'video', videoId: '777', welcomeMessage: 'Hi there' });
    expect(spec.link_data).toBeUndefined();
    expect(spec.video_data).toMatchObject({
      video_id: '777', image_hash: HASH, message: 'Hi', title: 'H',
      call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP', link: 'https://api.whatsapp.com/send' } },
    });
    expect((spec.video_data as Record<string, unknown>).page_welcome_message).toBeDefined();
    expect(() => creative({ format: 'video', videoId: null })).toThrow();
  });

  it('a carousel sends 2-10 cards; website cards may each open their own page', () => {
    const cards = [
      { imageHash: HASH, headline: 'One', description: null, link: 'https://shop.example/a' },
      { imageHash: HASH, headline: null, description: 'Two', link: null },
    ];
    const spec = creative({ kind: 'website', ctaType: 'SHOP_NOW', linkUrl: 'https://shop.example', format: 'carousel', cards });
    const link = spec.link_data as { child_attachments: Record<string, unknown>[]; link: string };
    expect(link.link).toBe('https://shop.example');
    expect(link.child_attachments).toHaveLength(2);
    expect(link.child_attachments[0]).toMatchObject({ name: 'One', link: 'https://shop.example/a', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://shop.example/a' } } });
    expect(link.child_attachments[1]).toMatchObject({ description: 'Two', link: 'https://shop.example' });
    expect(() => creative({ format: 'carousel', cards: cards.slice(0, 1) })).toThrow();
  });

  it('a single image keeps the shape it had before', () => {
    expect(creative()).toEqual({
      page_id: '2',
      link_data: {
        message: 'Hi', image_hash: HASH, name: 'H', link: 'https://api.whatsapp.com/send',
        call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } },
      },
    });
  });
});

describe('review feedback', () => {
  it("joins Meta's review reasons and delivery issues, without duplicates or control characters", () => {
    expect(reviewFeedbackOf({
      ad_review_feedback: { global: { POLICY: 'Ads may not make health claims.' }, placement_specific: { instagram: { POLICY: 'Ads may not make health claims.' } } },
      issues_info: [{ error_summary: 'Image text\u0007 too long' }],
    })).toBe('Ads may not make health claims. · Image text  too long');
    expect(reviewFeedbackOf({})).toBeNull();
    expect(reviewFeedbackOf({ ad_review_feedback: { global: { A: 'x'.repeat(2000) } } })).toHaveLength(1000);
  });
});

describe('targeting search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks Meta with the token in the header and keeps only well-formed options', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const answers: Record<string, unknown[]> = {
      adinterest: [{ id: '600', name: 'Yoga', path: ['Fitness', 'Yoga'], audience_size_upper_bound: 1200 }, { id: 'bad', name: 'x' }],
      adgeolocation: [{ key: '2295424', name: 'Mumbai', type: 'city', country_code: 'IN', region: 'Maharashtra', country_name: 'India' },
        { key: '1', name: 'Zip', type: 'zip' }],
      adlocale: [{ key: 6, name: 'English (US)' }, { key: 'x', name: 'bad' }],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ data: answers[new URL(url).searchParams.get('type')!] }), { status: 200 });
    }));
    expect(await searchTargeting('interest', 'yoga', 'tok')).toEqual([{ type: 'interest', id: '600', name: 'Yoga', detail: 'Fitness', countryCode: null, size: 1200 }]);
    expect(await searchTargeting('place', 'mum', 'tok')).toEqual([
      { type: 'city', id: '2295424', name: 'Mumbai', detail: 'Maharashtra, India', countryCode: 'IN', size: null }]);
    expect(await searchTargeting('locale', 'eng', 'tok')).toEqual([{ type: 'locale', id: '6', name: 'English (US)', detail: null, countryCode: null, size: null }]);
    expect(calls.every((c) => c.auth === 'Bearer tok' && !c.url.includes('tok'))).toBe(true);
    expect(new URL(calls[1].url).searchParams.get('location_types')).toBe('["region","city"]');
  });
});

describe('create input (formats and targeting)', () => {
  it('a video needs its uploaded id; a carousel 2-10 cards and a goal that supports it', () => {
    expect(parse({ format: 'video' })).toBeNull();
    expect(parse({ format: 'video', videoId: '777' })).toMatchObject({ format: 'video', videoId: '777', cards: null });
    const cards = [{ imageHash: HASH, headline: 'A' }, { imageHash: HASH }];
    expect(parse({ format: 'carousel', cards, imageHash: undefined })).toMatchObject({ format: 'carousel', imageHash: HASH });
    expect(parse({ format: 'carousel', cards: cards.slice(0, 1) })).toBeNull();
    expect(parse({ format: 'carousel', cards, kind: 'instagram_direct' })).toBeNull();
    expect(parse({ format: 'carousel', cards: [{ imageHash: 'nope' }, { imageHash: HASH }] })).toBeNull();
    expect(parse({ format: 'gif' })).toBeNull();
  });

  it('WhatsApp Status is offered for WhatsApp and website ads only; targeting choices are checked', () => {
    expect(parse({ placements: ['whatsapp_status'] })?.placements).toEqual(['whatsapp_status']);
    expect(parse({ kind: 'lead_form', leadFormId: '9', placements: ['whatsapp_status'] })).toBeNull();
    expect(parse({ placements: ['tiktok'] })).toBeNull();
    expect(parse({ interests: [{ id: '600', name: 'Yoga' }, { id: '600', name: 'Yoga' }] })?.interests).toEqual([{ id: '600', name: 'Yoga' }]);
    expect(parse({ interests: [{ id: 'x', name: 'Yoga' }] })).toBeNull();
    expect(parse({ places: [{ type: 'city', key: '22', name: 'Mumbai', countryCode: 'IN' }] })?.places).toHaveLength(1);
    expect(parse({ places: [{ type: 'zip', key: '22', name: 'x' }] })).toBeNull();
    expect(parse({ locales: [6, 6, 24] })?.locales).toEqual([6, 24]);
    expect(parse({ locales: ['en'] })).toBeNull();
  });

  it('a variant needs a source draft, text and an image', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    expect(parseAdVariantInput({ sourceId: id, primaryText: 'B text', imageHash: HASH })).toMatchObject({ sourceId: id, name: null, headline: null });
    for (const bad of [{ sourceId: 'x', primaryText: 'B', imageHash: HASH }, { sourceId: id, primaryText: '', imageHash: HASH }, { sourceId: id, primaryText: 'B', imageHash: 'x' }])
      expect(parseAdVariantInput(bad)).toBeNull();
  });

  it('accepts MP4/MOV by their first bytes only', () => {
    expect(isAdVideo(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0]))).toBe(true);
    expect(isAdVideo(new TextEncoder().encode('<script>alert(1)</script>'))).toBe(false);
  });
});

describe('rules', () => {
  it('parses a rule; a CTR is at most 100%', () => {
    const rule = { name: ' Stop  costly ', level: 'adset', metric: 'cost_per_result', operator: 'gt', threshold: 200, windowDays: 3, action: 'pause' };
    expect(parseAdRuleInput(rule)).toEqual({ name: 'Stop costly', level: 'adset', metric: 'cost_per_result', operator: 'gt', threshold: 200, windowDays: 3, minSpend: 0, action: 'pause' });
    for (const bad of [{ windowDays: 2 }, { threshold: -1 }, { metric: 'roas' }, { action: 'delete' }, { metric: 'ctr', threshold: 150 }, { name: '' }])
      expect(parseAdRuleInput({ ...rule, ...bad }), JSON.stringify(bad)).toBeNull();
  });

  it('measures each metric; spend with no result is the worst cost per result', () => {
    const totals = { spend: 600, impressions: 20_000, clicks: 100, results: 3 };
    expect(ruleValue('cost_per_result', totals)).toBe(200);
    expect(ruleValue('ctr', totals)).toBe(0.5);
    expect(ruleValue('cpm', totals)).toBe(30);
    expect(ruleValue('cost_per_result', { ...totals, results: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(ruleValue('ctr', { ...totals, impressions: 0 })).toBeNull();
  });

  it('acts only past the threshold and after the minimum spend', () => {
    const rule = { operator: 'gt' as const, threshold: 150, minSpend: 500 };
    expect(ruleMatches(rule, 600, 200)).toBe(true);
    expect(ruleMatches(rule, 400, 200)).toBe(false);
    expect(ruleMatches(rule, 600, 100)).toBe(false);
    expect(ruleMatches(rule, 600, Number.POSITIVE_INFINITY)).toBe(true);
    expect(ruleMatches({ operator: 'lt', threshold: 1, minSpend: 0 }, 10, 0.5)).toBe(true);
    expect(ruleMatches(rule, 600, null)).toBe(false);
  });
});
