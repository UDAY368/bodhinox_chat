import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_LIMITS,
  orderLimitedTimeOfferButtons,
  templateKindOf,
  validateHeader,
  validateTemplatePayload,
  type TemplatePayload,
} from './template-validators';
import type { CarouselCard, TemplateButton } from '@/types';
import { getT, type TranslateValues } from '@/lib/i18n/translate';

const t = getT('Validation.templates');

/** The validator throws exactly the translated message for `key`. */
function expectError(run: () => unknown, key: string, values?: TranslateValues) {
  expect(run).toThrow(t(key, values));
}

const ok = (run: () => unknown) => expect(run).not.toThrow();

const qr = (text = 'Shop now'): TemplateButton => ({ type: 'QUICK_REPLY', text });
const urlButton = (text = 'Visit'): TemplateButton => ({
  type: 'URL',
  text,
  url: 'https://shop.example/sale',
});
const copyCode = (example = 'SAVE20'): TemplateButton => ({
  type: 'COPY_CODE',
  text: 'Copy code',
  example,
});

function card(overrides: Partial<CarouselCard> = {}): CarouselCard {
  return {
    header_type: 'image',
    header_handle: 'h:card',
    body_text: 'A great pick.',
    buttons: [qr()],
    ...overrides,
  };
}

const carousel = (overrides: Partial<TemplatePayload> = {}): TemplatePayload => ({
  name: 'spring_carousel',
  category: 'Marketing',
  language: 'en_US',
  template_kind: 'carousel',
  body_text: 'New arrivals for you.',
  cards: [card(), card()],
  ...overrides,
});

const auth = (overrides: Partial<TemplatePayload> = {}): TemplatePayload => ({
  name: 'login_code',
  category: 'Authentication',
  language: 'en_US',
  template_kind: 'authentication',
  body_text: '',
  auth_options: { otp_type: 'COPY_CODE' },
  ...overrides,
});

const lto = (overrides: Partial<TemplatePayload> = {}): TemplatePayload => ({
  name: 'flash_sale',
  category: 'Marketing',
  language: 'en_US',
  template_kind: 'limited_time_offer',
  body_text: 'Our flash sale ends soon.',
  lto: { text: 'Flash sale', has_expiration: true },
  buttons: [copyCode(), urlButton()],
  ...overrides,
});

describe('templateKindOf', () => {
  it('treats an absent or null kind as standard', () => {
    expect(templateKindOf({})).toBe('standard');
    expect(templateKindOf({ template_kind: null })).toBe('standard');
    expect(templateKindOf({ template_kind: 'carousel' })).toBe('carousel');
  });
});

describe('validateTemplatePayload — kind dispatch', () => {
  it('rejects an unknown kind', () => {
    expectError(
      () => validateTemplatePayload({ ...carousel(), template_kind: 'poll' as never }),
      'kindInvalid',
      { kind: 'poll' },
    );
  });

  it('rejects fields that belong to another kind', () => {
    const standard: TemplatePayload = {
      name: 'hello',
      category: 'Utility',
      language: 'en_US',
      body_text: 'Hello',
    };
    expectError(() => validateTemplatePayload({ ...standard, cards: [card()] }), 'kindFieldNotAllowed', { field: 'cards' });
    expectError(() => validateTemplatePayload({ ...standard, lto: { text: 'x', has_expiration: false } }), 'kindFieldNotAllowed', { field: 'lto' });
    expectError(() => validateTemplatePayload({ ...carousel(), auth_options: { otp_type: 'COPY_CODE' } }), 'kindFieldNotAllowed', { field: 'auth_options' });
    // Nulls and empty arrays from a stored row are fine.
    ok(() => validateTemplatePayload({ ...standard, cards: [], lto: null, auth_options: null }));
  });
});

describe('location header', () => {
  const base: TemplatePayload = {
    name: 'store_visit',
    category: 'Utility',
    language: 'en_US',
    header_type: 'location',
    body_text: 'See you at our store.',
  };

  it('is accepted on standard Marketing and Utility templates', () => {
    ok(() => validateTemplatePayload(base));
    ok(() => validateTemplatePayload({ ...base, category: 'Marketing' }));
  });

  it('is refused on Authentication and on non-standard kinds', () => {
    expectError(() => validateTemplatePayload({ ...base, category: 'Authentication' }), 'locationHeaderCategory');
    expectError(() => validateTemplatePayload(lto({ header_type: 'location' })), 'locationHeaderCategory');
  });

  it('carries no text, media or sample', () => {
    expectError(() => validateHeader({ header_type: 'location', header_content: 'Here' }), 'locationHeaderNoContent');
    expectError(() => validateHeader({ header_type: 'location', header_media_url: 'https://x.example/a.png' }), 'locationHeaderNoContent');
    expectError(() => validateHeader({ header_type: 'location', header_handle: 'h:1' }), 'locationHeaderNoContent');
    expectError(
      () => validateTemplatePayload({ ...base, sample_values: { header: ['x'] } }),
      'headerSampleCountMismatch',
      { count: 0, got: 1 },
    );
  });
});

describe('carousel', () => {
  it('accepts a valid carousel', () => {
    expect(validateTemplatePayload(carousel())).toEqual({ bodyVarCount: 0, headerVarCount: 0 });
  });

  it('requires the Marketing category', () => {
    expectError(() => validateTemplatePayload(carousel({ category: 'Utility' })), 'carouselCategory');
  });

  it('forbids a top-level header, footer and buttons', () => {
    expectError(() => validateTemplatePayload(carousel({ header_type: 'text', header_content: 'Hi' })), 'carouselNoHeader');
    expectError(() => validateTemplatePayload(carousel({ footer_text: 'Bye' })), 'carouselNoFooter');
    expectError(() => validateTemplatePayload(carousel({ buttons: [qr()] })), 'carouselNoButtons');
  });

  it('checks the top body: required, 1024 chars, contiguous variables with samples', () => {
    ok(() => validateTemplatePayload(carousel({ body_text: 'x'.repeat(1024) })));
    expectError(() => validateTemplatePayload(carousel({ body_text: 'x'.repeat(1025) })), 'bodyTooLong', { max: 1024, got: 1025 });
    expectError(() => validateTemplatePayload(carousel({ body_text: ' ' })), 'bodyRequired');
    expectError(
      () => validateTemplatePayload(carousel({ body_text: 'Hi {{2}}', sample_values: { body: ['a'] } })),
      'bodyNotContiguous',
      { first: '{{1}}', found: '{{2}}' },
    );
    expectError(() => validateTemplatePayload(carousel({ body_text: 'Hi {{1}}.' })), 'bodySampleCountMismatch', { count: 1, got: 0 });
    ok(() => validateTemplatePayload(carousel({ body_text: 'Hi {{1}}.', sample_values: { body: ['Ana'] } })));
  });

  it('needs 2 to 10 cards', () => {
    const range = { min: 2, max: 10 };
    expectError(() => validateTemplatePayload(carousel({ cards: [card()] })), 'carouselCardCount', { ...range, got: 1 });
    expectError(() => validateTemplatePayload(carousel({ cards: undefined })), 'carouselCardCount', { ...range, got: 0 });
    ok(() => validateTemplatePayload(carousel({ cards: Array.from({ length: 10 }, () => card()) })));
    expectError(
      () => validateTemplatePayload(carousel({ cards: Array.from({ length: 11 }, () => card()) })),
      'carouselCardCount',
      { ...range, got: 11 },
    );
  });

  const cardError = (n: number, key: string, values?: TranslateValues) =>
    t('cardError', { n, message: t(key, values) });

  it('needs an image or video header on every card, in one format', () => {
    ok(() => validateTemplatePayload(carousel({ cards: [card({ header_type: 'video' }), card({ header_type: 'video' })] })));
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card(), card({ header_type: 'document' as never })] })),
    ).toThrow(cardError(2, 'cardHeaderType'));
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card(), card({ header_type: 'video' })] })),
    ).toThrow(cardError(2, 'cardHeaderMismatch', { format: 'image' }));
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card(), card({ header_handle: undefined })] })),
    ).toThrow(cardError(2, 'mediaHeaderRequiresSource', { type: 'image' }));
  });

  it('limits card bodies to 160 chars with contiguous variables and samples', () => {
    const max = TEMPLATE_LIMITS.cardBodyMaxLength;
    ok(() => validateTemplatePayload(carousel({ cards: [card({ body_text: 'x'.repeat(max) }), card()] })));
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card({ body_text: 'x'.repeat(max + 1) }), card()] })),
    ).toThrow(cardError(1, 'cardBodyTooLong', { max, got: max + 1 }));
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card(), card({ body_text: '' })] })),
    ).toThrow(cardError(2, 'cardBodyRequired'));
    expect(() =>
      validateTemplatePayload(
        carousel({ cards: [card({ body_text: 'Only {{2}}.', sample_values: { body: ['a'] } }), card()] }),
      ),
    ).toThrow(cardError(1, 'bodyNotContiguous', { first: '{{1}}', found: '{{2}}' }));
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card({ body_text: 'Price {{1}}.' }), card()] })),
    ).toThrow(cardError(1, 'bodySampleCountMismatch', { count: 1, got: 0 }));
    ok(() =>
      validateTemplatePayload(
        carousel({
          cards: [
            card({ body_text: 'Price {{1}}.', sample_values: { body: ['$5'] } }),
            card({ body_text: 'Price {{1}}.', sample_values: { body: ['$7'] } }),
          ],
        }),
      ),
    );
  });

  it('needs 1 or 2 buttons per card of quick reply, URL or phone type', () => {
    const range = { min: 1, max: 2 };
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card({ buttons: [] }), card({ buttons: [] })] })),
    ).toThrow(cardError(1, 'cardButtonCount', { ...range, got: 0 }));
    const two = [qr(), urlButton()];
    ok(() => validateTemplatePayload(carousel({ cards: [card({ buttons: two }), card({ buttons: two })] })));
    const three = [qr('a'), qr('b'), qr('c')];
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card({ buttons: three }), card({ buttons: three })] })),
    ).toThrow(cardError(1, 'cardButtonCount', { ...range, got: 3 }));
    const withCode = [copyCode()];
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card({ buttons: withCode }), card({ buttons: withCode })] })),
    ).toThrow(cardError(1, 'cardButtonType', { n: 1, type: 'COPY_CODE' }));
    const phone: TemplateButton[] = [{ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+15550001' }];
    ok(() => validateTemplatePayload(carousel({ cards: [card({ buttons: phone }), card({ buttons: phone })] })));
    const noText = [qr('')];
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card({ buttons: noText }), card({ buttons: noText })] })),
    ).toThrow(cardError(1, 'buttonMissingText', { n: 1, type: 'QUICK_REPLY' }));
  });

  it('requires every card to match card 1 button count, types and order', () => {
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card({ buttons: [qr(), urlButton()] }), card({ buttons: [qr()] })] })),
    ).toThrow(cardError(2, 'cardButtonsMismatch'));
    expect(() =>
      validateTemplatePayload(
        carousel({ cards: [card({ buttons: [qr(), urlButton()] }), card({ buttons: [urlButton(), qr()] })] }),
      ),
    ).toThrow(cardError(2, 'quickReplyInterleaved'));
    expect(() =>
      validateTemplatePayload(carousel({ cards: [card({ buttons: [urlButton()] }), card({ buttons: [qr()] })] })),
    ).toThrow(cardError(2, 'cardButtonsMismatch'));
  });
});

describe('authentication', () => {
  it('accepts the minimal shape and reports the one code variable', () => {
    expect(validateTemplatePayload(auth())).toEqual({ bodyVarCount: 1, headerVarCount: 0 });
  });

  it('ignores body_text, which Meta writes', () => {
    ok(() => validateTemplatePayload(auth({ body_text: 'anything {{3}}' })));
  });

  it('requires the Authentication category', () => {
    expectError(() => validateTemplatePayload(auth({ category: 'Utility' })), 'authCategory');
  });

  it('forbids a header, a custom footer and authored buttons', () => {
    expectError(() => validateTemplatePayload(auth({ header_type: 'text', header_content: 'x' })), 'authNoHeader');
    expectError(() => validateTemplatePayload(auth({ footer_text: 'x' })), 'authNoFooter');
    expectError(() => validateTemplatePayload(auth({ buttons: [qr()] })), 'authNoButtons');
  });

  it('requires options with the COPY_CODE otp type', () => {
    expectError(() => validateTemplatePayload(auth({ auth_options: null })), 'authOptionsRequired');
    expectError(
      () => validateTemplatePayload(auth({ auth_options: { otp_type: 'ONE_TAP' as never } })),
      'authOtpType',
    );
  });

  it('limits code expiry to whole minutes 1-90', () => {
    const range = { min: 1, max: 90 };
    const withExpiry = (code_expiration_minutes: number) =>
      auth({ auth_options: { otp_type: 'COPY_CODE', code_expiration_minutes } });
    ok(() => validateTemplatePayload(withExpiry(1)));
    ok(() => validateTemplatePayload(withExpiry(90)));
    expectError(() => validateTemplatePayload(withExpiry(0)), 'authExpiryRange', range);
    expectError(() => validateTemplatePayload(withExpiry(91)), 'authExpiryRange', range);
    expectError(() => validateTemplatePayload(withExpiry(1.5)), 'authExpiryRange', range);
  });

  it('checks the security flag and button text (25 chars)', () => {
    ok(() =>
      validateTemplatePayload(
        auth({ auth_options: { otp_type: 'COPY_CODE', add_security_recommendation: true, button_text: 'x'.repeat(25) } }),
      ),
    );
    expectError(
      () => validateTemplatePayload(auth({ auth_options: { otp_type: 'COPY_CODE', add_security_recommendation: 'yes' as never } })),
      'authSecurityFlag',
    );
    expectError(
      () => validateTemplatePayload(auth({ auth_options: { otp_type: 'COPY_CODE', button_text: 'x'.repeat(26) } })),
      'authButtonTextTooLong',
      { max: 25, got: 26 },
    );
    expectError(
      () => validateTemplatePayload(auth({ auth_options: { otp_type: 'COPY_CODE', button_text: '  ' } })),
      'authButtonTextEmpty',
    );
  });
});

describe('limited_time_offer', () => {
  it('accepts a valid offer', () => {
    ok(() => validateTemplatePayload(lto()));
    ok(() => validateTemplatePayload(lto({ lto: { text: 'Sale', has_expiration: false }, buttons: [urlButton()] })));
  });

  it('requires exactly one URL button (Meta: URL button is required)', () => {
    const noExpiry = { text: 'Sale', has_expiration: false };
    expectError(() => validateTemplatePayload(lto({ lto: noExpiry, buttons: [] })), 'ltoUrlButtonRequired');
    expectError(() => validateTemplatePayload(lto({ lto: noExpiry, buttons: [copyCode()] })), 'ltoUrlButtonRequired');
    expectError(() => validateTemplatePayload(lto({ buttons: [copyCode()] })), 'ltoUrlButtonRequired');
  });

  it('requires the copy-code button before the URL button', () => {
    expectError(() => validateTemplatePayload(lto({ buttons: [urlButton(), copyCode()] })), 'ltoCopyCodeFirst');
    ok(() => validateTemplatePayload(lto({ buttons: orderLimitedTimeOfferButtons([urlButton(), copyCode()]) })));
  });

  it('requires the Marketing category', () => {
    expectError(() => validateTemplatePayload(lto({ category: 'Utility' })), 'ltoCategory');
  });

  it('limits offer text to 1-16 chars and needs the expiry flag', () => {
    ok(() => validateTemplatePayload(lto({ lto: { text: 'x'.repeat(16), has_expiration: true } })));
    expectError(() => validateTemplatePayload(lto({ lto: { text: 'x'.repeat(17), has_expiration: true } })), 'ltoTextTooLong', { max: 16, got: 17 });
    expectError(() => validateTemplatePayload(lto({ lto: { text: ' ', has_expiration: true } })), 'ltoTextRequired');
    expectError(() => validateTemplatePayload(lto({ lto: null })), 'ltoTextRequired');
    expectError(
      () => validateTemplatePayload(lto({ lto: { text: 'Sale', has_expiration: 'yes' as never } })),
      'ltoExpirationFlag',
    );
  });

  it('allows no header, an image or a video header only', () => {
    ok(() => validateTemplatePayload(lto({ header_type: 'image', header_handle: 'h:1' })));
    ok(() => validateTemplatePayload(lto({ header_type: 'video', header_handle: 'h:1' })));
    expectError(() => validateTemplatePayload(lto({ header_type: 'text', header_content: 'Hi' })), 'ltoHeaderType');
    expectError(() => validateTemplatePayload(lto({ header_type: 'document', header_handle: 'h:1' })), 'ltoHeaderType');
    expectError(() => validateTemplatePayload(lto({ header_type: 'image' })), 'mediaHeaderRequiresSource', { type: 'image' });
  });

  it('limits the body to 600 chars and forbids a footer', () => {
    ok(() => validateTemplatePayload(lto({ body_text: 'x'.repeat(600) })));
    expectError(() => validateTemplatePayload(lto({ body_text: 'x'.repeat(601) })), 'ltoBodyTooLong', { max: 600, got: 601 });
    expectError(() => validateTemplatePayload(lto({ footer_text: 'Terms apply' })), 'ltoNoFooter');
  });

  it('allows at most one copy-code and one URL button', () => {
    ok(() => validateTemplatePayload(lto({ buttons: [copyCode(), urlButton()] })));
    expectError(
      () => validateTemplatePayload(lto({ buttons: [copyCode(), urlButton(), urlButton('Two')] })),
      'ltoTooManyButtons',
      { max: 2, got: 3 },
    );
    expectError(() => validateTemplatePayload(lto({ buttons: [copyCode(), qr()] })), 'ltoButtonTypes');
    expectError(() => validateTemplatePayload(lto({ buttons: [urlButton(), urlButton('Two')] })), 'ltoButtonTypes');
    expectError(() => validateTemplatePayload(lto({ buttons: [copyCode(), copyCode('B')] })), 'ltoButtonTypes');
  });

  it('rejects a body that starts or ends with a variable', () => {
    const samples = { body: ['Ana'] };
    expectError(() => validateTemplatePayload(lto({ body_text: '{{1}}, our sale ends soon.', sample_values: samples })), 'bodyVariableAtEdge');
    expectError(() => validateTemplatePayload(lto({ body_text: 'Our sale ends soon, {{1}}', sample_values: samples })), 'bodyVariableAtEdge');
    ok(() => validateTemplatePayload(lto({ body_text: 'Our sale ends soon, {{1}}.', sample_values: samples })));
  });

  it('needs a copy-code button only when the offer expires', () => {
    expectError(() => validateTemplatePayload(lto({ buttons: [urlButton()] })), 'ltoCopyCodeRequired');
    ok(() => validateTemplatePayload(lto({ lto: { text: 'Sale', has_expiration: false }, buttons: [urlButton()] })));
  });
});

describe('orderLimitedTimeOfferButtons', () => {
  it('puts the copy-code button first without mutating the input', () => {
    const input = [urlButton(), copyCode()];
    expect(orderLimitedTimeOfferButtons(input).map((b) => b.type)).toEqual(['COPY_CODE', 'URL']);
    expect(input.map((b) => b.type)).toEqual(['URL', 'COPY_CODE']);
    expect(orderLimitedTimeOfferButtons([copyCode(), urlButton()]).map((b) => b.type)).toEqual(['COPY_CODE', 'URL']);
    expect(orderLimitedTimeOfferButtons([urlButton()]).map((b) => b.type)).toEqual(['URL']);
  });
});

describe('variables at the edge of a body', () => {
  const standard = (body_text: string): TemplatePayload => ({
    name: 'hello',
    category: 'Utility',
    language: 'en_US',
    body_text,
    sample_values: { body: ['Ana'] },
  });

  it('rejects a standard body that starts or ends with a variable, after trimming', () => {
    expectError(() => validateTemplatePayload(standard('{{1}} your order shipped.')), 'bodyVariableAtEdge');
    expectError(() => validateTemplatePayload(standard('  {{1}} your order shipped.')), 'bodyVariableAtEdge');
    expectError(() => validateTemplatePayload(standard('Your order shipped, {{1}}  ')), 'bodyVariableAtEdge');
    ok(() => validateTemplatePayload(standard('Hi {{1}}, your order shipped.')));
    ok(() => validateTemplatePayload(standard('Your order shipped, {{1}}!')));
  });

  it('rejects a carousel main body or card body that starts or ends with a variable', () => {
    expectError(
      () => validateTemplatePayload(carousel({ body_text: '{{1}} new arrivals', sample_values: { body: ['Ana'] } })),
      'bodyVariableAtEdge',
    );
    const edgeCard = card({ body_text: 'Only {{1}}', sample_values: { body: ['$10'] } });
    expect(() => validateTemplatePayload(carousel({ cards: [card(), edgeCard] }))).toThrow(
      t('cardError', { n: 2, message: t('bodyVariableAtEdge') }),
    );
  });
});

describe('library placeholders at submit time', () => {
  const withButtons = (buttons: TemplateButton[]): TemplatePayload => ({
    name: 'hello',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Your order is ready.',
    buttons,
  });

  it('rejects the library placeholder URL, however it is cased or slashed', () => {
    for (const url of ['https://example.com', 'https://example.com/', ' HTTPS://www.EXAMPLE.com/ ']) {
      expectError(
        () => validateTemplatePayload(withButtons([{ type: 'URL', text: 'Track', url }])),
        'buttonPlaceholderUrl',
        { n: 1, url: 'https://example.com' },
      );
    }
    ok(() => validateTemplatePayload(withButtons([{ type: 'URL', text: 'Track', url: 'https://shop.example/track' }])));
    ok(() => validateTemplatePayload(withButtons([{ type: 'URL', text: 'Track', url: 'https://example.com/track' }])));
  });

  it('rejects the +10000000000 phone placeholder, however it is formatted', () => {
    for (const phone_number of ['+10000000000', '+1 000 000 0000']) {
      expectError(
        () => validateTemplatePayload(withButtons([{ type: 'QUICK_REPLY', text: 'Ok' }, { type: 'PHONE_NUMBER', text: 'Call', phone_number }])),
        'buttonPlaceholderPhone',
        { n: 2, phone: '+10000000000' },
      );
    }
    ok(() => validateTemplatePayload(withButtons([{ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+14155550100' }])));
  });
});
