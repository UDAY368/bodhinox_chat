import { describe, expect, it } from 'vitest';
import { AUTH_CODE_MAX_LENGTH, buildSendComponents } from './template-send-builder';
import type { CarouselCard, MessageTemplate } from '@/types';
import { getT } from '@/lib/i18n/translate';

const t = getT('Validation.templates');

function row(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 'row-1',
    user_id: 'user-1',
    name: 'tpl',
    category: 'Marketing',
    language: 'en_US',
    body_text: 'Hello.',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildSendComponents — location header', () => {
  const template = row({ header_type: 'location', category: 'Utility' });

  it('sends the location as the header parameter', () => {
    expect(
      buildSendComponents(template, {
        location: { latitude: 37.48, longitude: -122.15, name: 'Main store', address: '1 Market St' },
      }),
    ).toEqual([
      {
        type: 'header',
        parameters: [
          {
            type: 'location',
            location: { latitude: 37.48, longitude: -122.15, name: 'Main store', address: '1 Market St' },
          },
        ],
      },
    ]);
  });

  it('omits a blank name and address', () => {
    expect(buildSendComponents(template, { location: { latitude: 0, longitude: 0, name: ' ' } })).toEqual([
      { type: 'header', parameters: [{ type: 'location', location: { latitude: 0, longitude: 0 } }] },
    ]);
  });

  it('requires valid coordinates', () => {
    expect(() => buildSendComponents(template)).toThrow(t('locationValueRequired'));
    expect(() => buildSendComponents(template, { location: { latitude: 90, longitude: 180 } })).not.toThrow();
    expect(() => buildSendComponents(template, { location: { latitude: 90.1, longitude: 0 } })).toThrow(
      t('locationValueInvalid'),
    );
    expect(() => buildSendComponents(template, { location: { latitude: 0, longitude: -180.1 } })).toThrow(
      t('locationValueInvalid'),
    );
    expect(() => buildSendComponents(template, { location: { latitude: NaN, longitude: 0 } })).toThrow(
      t('locationValueInvalid'),
    );
  });
});

describe('buildSendComponents — authentication', () => {
  const template = row({
    category: 'Authentication',
    template_kind: 'authentication',
    body_text: '',
    auth_options: { otp_type: 'COPY_CODE' },
  });

  it('puts the code in the body and the OTP button', () => {
    expect(buildSendComponents(template, { authCode: '483920' })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '483920' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '483920' }] },
    ]);
  });

  it('ignores the stored body and any body values', () => {
    const withBody = { ...template, body_text: 'Custom {{1}} {{2}}' };
    expect(buildSendComponents(withBody, { authCode: '1', body: ['a', 'b'] })).toHaveLength(2);
  });

  it('requires a code of at most 15 characters', () => {
    expect(() => buildSendComponents(template)).toThrow(t('authCodeRequired'));
    expect(() => buildSendComponents(template, { authCode: '  ' })).toThrow(t('authCodeRequired'));
    expect(() => buildSendComponents(template, { authCode: 'x'.repeat(AUTH_CODE_MAX_LENGTH) })).not.toThrow();
    expect(() => buildSendComponents(template, { authCode: 'x'.repeat(AUTH_CODE_MAX_LENGTH + 1) })).toThrow(
      t('authCodeTooLong', { max: AUTH_CODE_MAX_LENGTH }),
    );
  });
});

describe('buildSendComponents — limited_time_offer', () => {
  const template = row({
    template_kind: 'limited_time_offer',
    header_type: 'image',
    header_media_url: 'https://cdn.example/sale.jpg',
    body_text: 'Hi {{1}}, sale ends soon.',
    lto: { text: 'Flash sale', has_expiration: true },
    buttons: [
      { type: 'COPY_CODE', text: 'Copy code', example: 'SAVE20' },
      { type: 'URL', text: 'Shop', url: 'https://shop.example/{{1}}', example: 'https://shop.example/a' },
    ],
  });

  it('emits header, offer expiry, body, coupon and URL button', () => {
    expect(
      buildSendComponents(template, {
        body: ['Ana'],
        offerExpirationTimeMs: 1_800_000_000_000,
        couponCode: 'ANA25',
        buttonParams: { 1: 'sale-42' },
      }),
    ).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.example/sale.jpg' } }] },
      {
        type: 'limited_time_offer',
        parameters: [
          { type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: 1_800_000_000_000 } },
        ],
      },
      { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
      {
        type: 'button',
        sub_type: 'copy_code',
        index: '0',
        parameters: [{ type: 'coupon_code', coupon_code: 'ANA25' }],
      },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'sale-42' }] },
    ]);
  });

  it('falls back to the stored code, and buttonParams beats couponCode', () => {
    const base = { body: ['Ana'], offerExpirationTimeMs: 1, buttonParams: { 1: 'x' } };
    const coupon = (params: Parameters<typeof buildSendComponents>[1]) =>
      buildSendComponents(template, params).find((c) => c.type === 'button' && c.sub_type === 'copy_code');
    expect(coupon(base)).toMatchObject({ parameters: [{ coupon_code: 'SAVE20' }] });
    expect(coupon({ ...base, couponCode: 'C', buttonParams: { 0: 'B', 1: 'x' } })).toMatchObject({
      parameters: [{ coupon_code: 'B' }],
    });
  });

  it('requires a positive whole expiry only when the offer expires', () => {
    const params = { body: ['Ana'], buttonParams: { 1: 'x' } };
    expect(() => buildSendComponents(template, params)).toThrow(t('ltoExpirationRequired'));
    expect(() => buildSendComponents(template, { ...params, offerExpirationTimeMs: 0 })).toThrow(
      t('ltoExpirationRequired'),
    );
    expect(() => buildSendComponents(template, { ...params, offerExpirationTimeMs: 1.5 })).toThrow(
      t('ltoExpirationRequired'),
    );
    const open = { ...template, lto: { text: 'Sale', has_expiration: false } };
    expect(buildSendComponents(open, params).some((c) => c.type === 'limited_time_offer')).toBe(false);
  });
});

describe('buildSendComponents — carousel', () => {
  const card = (overrides: Partial<CarouselCard> = {}): CarouselCard => ({
    header_type: 'image',
    header_media_url: 'https://cdn.example/card.jpg',
    body_text: 'Item',
    buttons: [
      { type: 'QUICK_REPLY', text: 'More' },
      { type: 'URL', text: 'Buy', url: 'https://shop.example/{{1}}', example: 'https://shop.example/1' },
    ],
    ...overrides,
  });
  const template = row({
    template_kind: 'carousel',
    body_text: 'Hi {{1}}, picks for you.',
    cards: [card({ body_text: 'Shoes {{1}}' }), card({ header_media_url: undefined })],
  });

  it('emits the top body and one component set per card', () => {
    expect(
      buildSendComponents(template, {
        body: ['Ana'],
        cards: [
          { body: ['$40'], buttonParams: { 0: 'more-shoes', 1: 'shoes' } },
          { headerMediaId: 'media-9', buttonParams: { 1: 'bags' } },
        ],
      }),
    ).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
      {
        type: 'carousel',
        cards: [
          {
            card_index: 0,
            components: [
              { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.example/card.jpg' } }] },
              { type: 'body', parameters: [{ type: 'text', text: '$40' }] },
              { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'more-shoes' }] },
              { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'shoes' }] },
            ],
          },
          {
            card_index: 1,
            components: [
              { type: 'header', parameters: [{ type: 'image', image: { id: 'media-9' } }] },
              { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'More' }] },
              { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'bags' }] },
            ],
          },
        ],
      },
    ]);
  });

  it('sends video card headers as video', () => {
    const video = row({
      template_kind: 'carousel',
      body_text: 'Watch',
      cards: [card({ header_type: 'video', buttons: [{ type: 'QUICK_REPLY', text: 'Go' }] })],
    });
    const [carousel] = buildSendComponents(video);
    expect(carousel.type === 'carousel' && carousel.cards[0].components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'video', video: { link: 'https://cdn.example/card.jpg' } }],
    });
  });

  it('names the card when a value is missing', () => {
    expect(() => buildSendComponents(template, { body: ['Ana'] })).toThrow(
      t('cardError', { n: 1, message: t('bodyValuesMissing', { count: 1, got: 0 }) }),
    );
    expect(() =>
      buildSendComponents(template, {
        body: ['Ana'],
        cards: [{ body: ['$1'], buttonParams: { 1: 'a' } }, { buttonParams: { 1: 'b' } }],
      }),
    ).toThrow(t('cardMediaSendSource', { n: 2, type: 'image' }));
    expect(() =>
      buildSendComponents(template, {
        body: ['Ana'],
        cards: [{ body: ['$1'] }, { headerMediaId: 'm' }],
      }),
    ).toThrow(t('cardError', { n: 1, message: t('urlButtonParamRequired', { n: 2, var: '{{1}}', index: 1 }) }));
  });
});

describe('buildSendComponents — standard templates are unchanged', () => {
  it('ignores the new params on a standard template', () => {
    const template = row({ body_text: 'Hi {{1}}' });
    expect(
      buildSendComponents(template, {
        body: ['Ana'],
        authCode: '1',
        offerExpirationTimeMs: 5,
        location: { latitude: 1, longitude: 1 },
        cards: [{}],
      }),
    ).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }]);
  });
});
