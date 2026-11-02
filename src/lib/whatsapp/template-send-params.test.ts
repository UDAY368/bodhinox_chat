import { describe, expect, it } from 'vitest';
import type { MessageTemplate } from '@/types';
import { buildSendComponents } from './template-send-builder';
import {
  CAMPAIGN_VARIABLE_KEY,
  assertTemplateSendable,
  campaignVariableKeys,
  flowTemplateExtrasIssues,
  flowTemplateSendExtras,
  parseCampaignSendExtras,
  parseSendTimeParams,
  splitFrozenParams,
  storedCampaignSendExtras,
  templateSendNeeds,
  templateSendRefusal,
  TemplateSendRefusedError,
} from './template-send-params';

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function row(over: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: 'tpl-1',
    user_id: 'u-1',
    name: 'tpl',
    category: 'Marketing',
    language: 'en_US',
    body_text: 'Hi {{1}}',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const AUTH = row({ category: 'Authentication', template_kind: 'authentication', body_text: '' });
const LOCATION = row({ header_type: 'location', body_text: 'Visit us, {{1}}' });
const OFFER = row({
  template_kind: 'limited_time_offer',
  lto: { text: 'Ends soon', has_expiration: true },
  body_text: 'Deal for {{1}}',
  buttons: [
    { type: 'COPY_CODE', text: 'Copy code', example: 'SAVE10' },
    { type: 'URL', text: 'Shop', url: 'https://shop.test/{{1}}', example: 'https://shop.test/x' },
  ],
});
const CAROUSEL = row({
  template_kind: 'carousel',
  body_text: 'Picks for {{1}}',
  cards: [
    { header_type: 'image', header_media_url: 'https://cdn.test/a.png', body_text: 'Card A {{1}} {{2}}', buttons: [{ type: 'QUICK_REPLY', text: 'More' }] },
    { header_type: 'image', header_media_url: 'https://cdn.test/b.png', body_text: 'Card B', buttons: [{ type: 'QUICK_REPLY', text: 'More' }] },
    { header_type: 'video', header_media_url: 'https://cdn.test/c.mp4', body_text: 'Card C {{1}}', buttons: [{ type: 'QUICK_REPLY', text: 'More' }] },
  ],
});

describe('templateSendRefusal', () => {
  it('lets authentication templates go out only from the inbox and the API', () => {
    expect(templateSendRefusal(AUTH, 'inbox')).toBeNull();
    expect(templateSendRefusal(AUTH, 'api')).toBeNull();
    for (const surface of ['campaign', 'automation', 'flow'] as const) {
      expect(templateSendRefusal(AUTH, surface)).toEqual(expect.any(String));
      expect(() => assertTemplateSendable(AUTH, surface)).toThrow(TemplateSendRefusedError);
    }
  });

  it('never refuses the other kinds or a missing row', () => {
    for (const tpl of [row({}), LOCATION, OFFER, CAROUSEL, null]) {
      expect(templateSendRefusal(tpl, 'campaign')).toBeNull();
      expect(templateSendRefusal(tpl, 'flow')).toBeNull();
    }
  });
});

describe('templateSendNeeds', () => {
  it('reports exactly the values each kind asks for', () => {
    expect(templateSendNeeds(row({}))).toMatchObject({ kind: 'standard', bodyVars: [1], location: false, offerExpiration: false, authCode: false, cards: [] });
    expect(templateSendNeeds(AUTH)).toMatchObject({ authCode: true, bodyVars: [] });
    expect(templateSendNeeds(LOCATION)).toMatchObject({ location: true, bodyVars: [1] });
    const offer = templateSendNeeds(OFFER);
    expect(offer).toMatchObject({ offerExpiration: true, couponButtons: [{ index: 0, example: 'SAVE10' }] });
    expect(offer.urlButtons).toEqual([{ index: 1, text: 'Shop', url: 'https://shop.test/{{1}}' }]);
    expect(templateSendNeeds(CAROUSEL).cards.map((c) => c.bodyVars)).toEqual([[1, 2], [], [1]]);
  });

  it('asks for no offer end when the offer has none', () => {
    expect(templateSendNeeds({ ...OFFER, lto: { text: 'x', has_expiration: false } }).offerExpiration).toBe(false);
  });
});

describe('campaign variable slots', () => {
  it('orders body placeholders before each card placeholder', () => {
    expect(campaignVariableKeys(CAROUSEL)).toEqual(['1', 'c1_1', 'c1_2', 'c3_1']);
    expect(campaignVariableKeys(row({ body_text: '{{2}} {{1}}' }))).toEqual(['1', '2']);
    for (const key of ['1', '99', 'c1_1', 'c10_12']) expect(CAMPAIGN_VARIABLE_KEY.test(key)).toBe(true);
    for (const key of ['0', '100', 'c0_1', 'c11_1', 'c1_0', '__proto__']) expect(CAMPAIGN_VARIABLE_KEY.test(key)).toBe(false);
  });

  it('cuts frozen values back into body and card values', () => {
    expect(splitFrozenParams(CAROUSEL, ['Ana', 'x', 'y', 'z'])).toEqual({
      body: ['Ana'],
      cards: [{ body: ['x', 'y'] }, {}, { body: ['z'] }],
    });
    // Standard templates keep the flat list untouched.
    expect(splitFrozenParams(row({}), ['a', 'b'])).toEqual({ body: ['a', 'b'] });
  });

  it('builds a carousel send from split values', () => {
    const components = buildSendComponents(CAROUSEL, splitFrozenParams(CAROUSEL, ['Ana', 'x', 'y', 'z']));
    const carousel = components.find((c) => c.type === 'carousel');
    expect(carousel && 'cards' in carousel ? carousel.cards.map((c) => c.components.find((x) => x.type === 'body')) : []).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] },
      undefined,
      { type: 'body', parameters: [{ type: 'text', text: 'z' }] },
    ]);
  });
});

describe('parseSendTimeParams', () => {
  it('accepts every structured value and drops unknown keys', () => {
    const r = parseSendTimeParams({
      body: ['Ana', 7],
      headerText: 'Hi',
      buttonParams: { 1: 'abc' },
      location: { latitude: '37.48', longitude: -122.14, name: ' HQ ', address: '' },
      offerExpirationTimeMs: NOW + 60_000,
      couponCode: ' SAVE10 ',
      authCode: '123456',
      cards: [{ body: ['x'] }, null],
      extra: 'ignored',
    }, NOW);
    expect(r).toEqual({ ok: true, value: {
      body: ['Ana', '7'],
      headerText: 'Hi',
      buttonParams: { 1: 'abc' },
      location: { latitude: 37.48, longitude: -122.14, name: 'HQ' },
      offerExpirationTimeMs: NOW + 60_000,
      couponCode: 'SAVE10',
      authCode: '123456',
      cards: [{ body: ['x'] }, {}],
    } });
    expect(parseSendTimeParams(null)).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['a non-object', 'nope'],
    ['a body that is not a list', { body: 'Ana' }],
    ['a body value that is an object', { body: [{}] }],
    ['an over-long value', { body: ['x'.repeat(1025)] }],
    ['a button keyed by name', { buttonParams: { first: 'x' } }],
    ['a latitude out of range', { location: { latitude: 91, longitude: 0 } }],
    ['a missing longitude', { location: { latitude: 1 } }],
    ['an offer end in the past', { offerExpirationTimeMs: NOW - 1 }],
    ['an offer end that is not whole ms', { offerExpirationTimeMs: NOW + 0.5 }],
    ['a coupon over 15 characters', { couponCode: 'X'.repeat(16) }],
    ['a blank one-time code', { authCode: '  ' }],
    ['a one-time code over 15 characters', { authCode: '1'.repeat(16) }],
    ['more than 10 cards', { cards: Array.from({ length: 11 }, () => ({})) }],
  ])('rejects %s', (_, raw) => {
    expect(parseSendTimeParams(raw, NOW).ok).toBe(false);
  });
});

describe('campaign extras', () => {
  it('checks the offer end against when sending starts', () => {
    const scheduled = NOW + 3_600_000;
    expect(parseCampaignSendExtras({ offerExpirationTimeMs: NOW + 60_000 }, scheduled).ok).toBe(false);
    expect(parseCampaignSendExtras({ offerExpirationTimeMs: scheduled + 60_000, couponCode: 'A1', location: { latitude: 1, longitude: 2 } }, scheduled))
      .toEqual({ ok: true, value: { offerExpirationTimeMs: scheduled + 60_000, couponCode: 'A1', location: { latitude: 1, longitude: 2 } } });
    expect(parseCampaignSendExtras(undefined)).toEqual({ ok: true, value: {} });
  });

  it('keeps only well-formed stored values', () => {
    expect(storedCampaignSendExtras({ location: { latitude: 'x' }, offerExpirationTimeMs: 5, couponCode: 'X'.repeat(30) })).toEqual({ offerExpirationTimeMs: 5 });
    expect(storedCampaignSendExtras(null)).toEqual({});
  });
});

describe('flow send_template extras', () => {
  it('reports bad saved values by field', () => {
    const issues = flowTemplateExtrasIssues({
      location: { latitude: '200', longitude: '0' },
      offer_expires_in_minutes: 0,
      coupon_code: 5,
      card_params: [['ok', ''], 'x'],
    });
    expect(issues.map((i) => i.field)).toEqual(['location', 'offer_expires_in_minutes', 'coupon_code', 'card_params.0.1', 'card_params.1']);
    expect(flowTemplateExtrasIssues({ location: { latitude: '1.5', longitude: '2' }, offer_expires_in_minutes: 30, coupon_code: '{{vars.code}}', card_params: [['{{vars.a}}']] })).toEqual([]);
  });

  it('turns config into send values at run time', () => {
    const fill = (s: string) => s.replace('{{vars.code}}', 'ABC').replace('{{vars.empty}}', '');
    expect(flowTemplateSendExtras({
      location: { latitude: '1.5', longitude: 2 },
      offer_expires_in_minutes: 30,
      coupon_code: '{{vars.code}}',
      card_params: [['{{vars.empty}}', 'x']],
    }, fill, NOW)).toEqual({
      location: { latitude: 1.5, longitude: 2 },
      offerExpirationTimeMs: NOW + 30 * 60_000,
      couponCode: 'ABC',
      cards: [{ body: ['-', 'x'] }],
    });
    expect(flowTemplateSendExtras({}, fill, NOW)).toEqual({});
  });
});
