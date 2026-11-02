import { describe, expect, it } from 'vitest';
import type { MessageTemplate, MessageTemplateStatus } from '@/types';
import {
  LIBRARY_PHONE_PLACEHOLDER,
  LIBRARY_URL_PLACEHOLDER,
} from '@/lib/whatsapp/template-library';
import {
  addCard,
  addCardButton,
  canRemoveCard,
  countTemplateTabs,
  emptyTemplateForm,
  filterTemplates,
  formFromTemplate,
  hasLibraryPlaceholder,
  isLocalDraft,
  patchButton,
  removeCard,
  removeCardButton,
  setCardButtonType,
  templateHealth,
  templatePayloadFromForm,
  templateTabOf,
  withTemplateKind,
  type CardForm,
} from './template-manager-helpers';
import { orderLimitedTimeOfferButtons } from '@/lib/whatsapp/template-validators';

const row = (name: string, status?: MessageTemplateStatus) => ({ name, status });

describe('templateTabOf', () => {
  it('maps every stored status onto one tab', () => {
    const cases: [MessageTemplateStatus | undefined, string][] = [
      ['APPROVED', 'approved'],
      ['PENDING', 'pending'],
      ['IN_APPEAL', 'pending'],
      ['PENDING_DELETION', 'pending'],
      ['REJECTED', 'rejected'],
      ['DRAFT', 'drafts'],
      [undefined, 'drafts'],
      ['PAUSED', 'paused'],
      ['DISABLED', 'paused'],
    ];
    for (const [status, tab] of cases) expect(templateTabOf(status)).toBe(tab);
  });
});

describe('countTemplateTabs / filterTemplates', () => {
  const rows = [
    row('welcome', 'APPROVED'),
    row('order_update', 'APPROVED'),
    row('promo', 'REJECTED'),
    row('promo_copy', 'DRAFT'),
    row('old', 'DISABLED'),
    row('waiting', 'PENDING'),
  ];

  it('counts each tab and all', () => {
    expect(countTemplateTabs(rows)).toEqual({
      all: 6,
      approved: 2,
      pending: 1,
      rejected: 1,
      drafts: 1,
      paused: 1,
    });
  });

  it('filters by tab and case-insensitive name search together', () => {
    expect(filterTemplates(rows, 'approved', '').map((r) => r.name)).toEqual([
      'welcome',
      'order_update',
    ]);
    expect(filterTemplates(rows, 'all', 'PROMO').map((r) => r.name)).toEqual([
      'promo',
      'promo_copy',
    ]);
    expect(filterTemplates(rows, 'drafts', 'promo').map((r) => r.name)).toEqual(['promo_copy']);
    expect(filterTemplates(rows, 'paused', 'nothing')).toEqual([]);
  });
});

describe('templateHealth / isLocalDraft', () => {
  it('buckets quality scores and treats anything else as unknown', () => {
    expect(templateHealth('GREEN')).toBe('green');
    expect(templateHealth('yellow')).toBe('yellow');
    expect(templateHealth('RED')).toBe('red');
    expect(templateHealth(undefined)).toBe('unknown');
    expect(templateHealth('UNKNOWN')).toBe('unknown');
  });

  it('a row without a Meta id is a local draft', () => {
    expect(isLocalDraft({ meta_template_id: undefined })).toBe(true);
    expect(isLocalDraft({ meta_template_id: '123' })).toBe(false);
  });
});

function card(types: CardForm['buttons'][number]['type'][]): CardForm {
  return {
    header_media_url: 'https://cdn.example.com/a.png',
    body_text: 'Card',
    body_samples: [],
    buttons: types.map((type) =>
      type === 'URL'
        ? { type, text: 'Open', url: 'https://example.com' }
        : type === 'PHONE_NUMBER'
          ? { type, text: 'Call', phone_number: '+10000000000' }
          : { type: 'QUICK_REPLY', text: 'Yes' },
    ),
  };
}

describe('carousel card button sync', () => {
  it('adding a button adds the same empty slot to every card, up to the card max', () => {
    const one = addCardButton([card(['QUICK_REPLY']), card(['QUICK_REPLY'])], 'URL');
    expect(one.map((c) => c.buttons.map((b) => b.type))).toEqual([
      ['QUICK_REPLY', 'URL'],
      ['QUICK_REPLY', 'URL'],
    ]);
    expect(one[1].buttons[1]).toEqual({ type: 'URL', text: '', url: '' });
    // Already at two buttons per card: unchanged.
    expect(addCardButton(one).map((c) => c.buttons.length)).toEqual([2, 2]);
  });

  it('removing or retyping a slot applies to every card and keeps the other values', () => {
    const cards = [card(['QUICK_REPLY', 'URL']), card(['QUICK_REPLY', 'URL'])];
    const removed = removeCardButton(cards, 0);
    expect(removed.map((c) => c.buttons)).toEqual([
      [{ type: 'URL', text: 'Open', url: 'https://example.com' }],
      [{ type: 'URL', text: 'Open', url: 'https://example.com' }],
    ]);
    const retyped = setCardButtonType(cards, 1, 'PHONE_NUMBER');
    expect(retyped.map((c) => c.buttons.map((b) => b.type))).toEqual([
      ['QUICK_REPLY', 'PHONE_NUMBER'],
      ['QUICK_REPLY', 'PHONE_NUMBER'],
    ]);
    expect(retyped[0].buttons[0]).toEqual({ type: 'QUICK_REPLY', text: 'Yes' });
    // The input is not mutated.
    expect(cards[0].buttons[1].type).toBe('URL');
  });

  it('a new card mirrors the first card button types, emptied, within 2..10 cards', () => {
    const cards = addCard([card(['QUICK_REPLY', 'URL']), card(['QUICK_REPLY', 'URL'])]);
    expect(cards).toHaveLength(3);
    expect(cards[2]).toEqual({
      header_media_url: '',
      body_text: '',
      body_samples: [],
      buttons: [
        { type: 'QUICK_REPLY', text: '' },
        { type: 'URL', text: '', url: '' },
      ],
    });
    const ten = Array.from({ length: 10 }, () => card(['QUICK_REPLY']));
    expect(addCard(ten)).toHaveLength(10);
    expect(removeCard(cards, 0)).toHaveLength(2);
    expect(removeCard(removeCard(cards, 0), 0)).toHaveLength(2);
  });

  it('patchButton only applies fields of the button own type', () => {
    expect(patchButton({ type: 'QUICK_REPLY', text: 'a' }, { text: 'b', url: 'x' })).toEqual({
      type: 'QUICK_REPLY',
      text: 'b',
    });
    expect(
      patchButton({ type: 'URL', text: 'a', url: 'u' }, { url: 'v', phone_number: '1' }),
    ).toEqual({ type: 'URL', text: 'a', url: 'v' });
  });
});

describe('withTemplateKind', () => {
  it('forces the category and header each kind allows and seeds carousel cards', () => {
    const base = { ...emptyTemplateForm(), header_format: 'text' as const, category: 'Utility' as const };
    const auth = withTemplateKind(base, 'authentication');
    expect(auth.category).toBe('Authentication');
    expect(auth.header_format).toBe('none');
    const carousel = withTemplateKind(base, 'carousel');
    expect(carousel.category).toBe('Marketing');
    expect(carousel.cards).toHaveLength(2);
    const lto = withTemplateKind({ ...base, header_format: 'image' }, 'limited_time_offer');
    expect(lto.header_format).toBe('image');
    expect(withTemplateKind(auth, 'standard').category).toBe('Marketing');
  });
});

describe('templatePayloadFromForm', () => {
  it('standard: keeps header, footer, buttons and only the samples for real variables', () => {
    const form = {
      ...emptyTemplateForm(),
      name: ' order_update ',
      category: 'Utility' as const,
      header_format: 'location' as const,
      header_content: 'stale',
      body_text: 'Hi {{1}}',
      body_samples: ['Ana', 'leftover'],
      footer_text: 'Thanks',
      buttons: [{ type: 'QUICK_REPLY' as const, text: 'OK' }],
      lto_text: 'ignored',
    };
    expect(templatePayloadFromForm(form)).toEqual({
      name: 'order_update',
      category: 'Utility',
      language: 'en_US',
      template_kind: 'standard',
      header_type: 'location',
      body_text: 'Hi {{1}}',
      footer_text: 'Thanks',
      buttons: [{ type: 'QUICK_REPLY', text: 'OK' }],
      sample_values: { body: ['Ana'] },
    });
  });

  it('authentication: sends only auth options with an empty body', () => {
    const form = {
      ...withTemplateKind({ ...emptyTemplateForm(), name: 'otp', body_text: 'x' }, 'authentication'),
      auth_expiry: '10',
      auth_button_text: ' Copy ',
      footer_text: 'ignored',
    };
    expect(templatePayloadFromForm(form)).toEqual({
      name: 'otp',
      category: 'Authentication',
      language: 'en_US',
      template_kind: 'authentication',
      body_text: '',
      auth_options: {
        otp_type: 'COPY_CODE',
        add_security_recommendation: true,
        code_expiration_minutes: 10,
        button_text: 'Copy',
      },
    });
  });

  it('carousel: cards share the media type and no header/footer/buttons are sent', () => {
    const form = {
      ...withTemplateKind({ ...emptyTemplateForm(), name: 'deals', body_text: 'Look' }, 'carousel'),
      card_format: 'video' as const,
      footer_text: 'ignored',
      buttons: [{ type: 'QUICK_REPLY' as const, text: 'ignored' }],
    };
    form.cards = [
      { ...card(['QUICK_REPLY']), body_text: 'A {{1}}', body_samples: ['x'], header_handle: 'h1' },
      card(['QUICK_REPLY']),
    ];
    const p = templatePayloadFromForm(form);
    expect(p.header_type).toBeUndefined();
    expect(p.footer_text).toBeUndefined();
    expect(p.buttons).toBeUndefined();
    expect(p.cards).toEqual([
      {
        header_type: 'video',
        header_media_url: 'https://cdn.example.com/a.png',
        header_handle: 'h1',
        body_text: 'A {{1}}',
        sample_values: { body: ['x'] },
        buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }],
      },
      {
        header_type: 'video',
        header_media_url: 'https://cdn.example.com/a.png',
        body_text: 'Card',
        buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }],
      },
    ]);
  });

  it('limited-time offer: sends lto and drops footer and non-media headers', () => {
    const form = {
      ...withTemplateKind({ ...emptyTemplateForm(), name: 'sale', body_text: 'Sale' }, 'limited_time_offer'),
      lto_text: ' Weekend ',
      lto_has_expiration: true,
      footer_text: 'ignored',
      buttons: [{ type: 'COPY_CODE' as const, text: 'Copy', example: 'SAVE10' }],
    };
    const p = templatePayloadFromForm(form);
    expect(p.lto).toEqual({ text: 'Weekend', has_expiration: true });
    expect(p.footer_text).toBeUndefined();
    expect(p.header_type).toBeUndefined();
    expect(p.buttons).toHaveLength(1);
  });
});

describe('formFromTemplate', () => {
  it('round-trips a stored carousel row (nulls from the database included)', () => {
    const stored = {
      id: 't1',
      name: 'deals',
      category: 'Marketing',
      language: 'pt_BR',
      header_type: null,
      body_text: 'Look',
      template_kind: 'carousel',
      cards: [
        { header_type: 'image', header_media_url: 'https://cdn.example.com/a.png', body_text: 'A', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] },
        { header_type: 'image', header_media_url: 'https://cdn.example.com/b.png', body_text: 'B', buttons: [{ type: 'QUICK_REPLY', text: 'No' }] },
      ],
      auth_options: null,
      lto: null,
    } as unknown as MessageTemplate;
    const form = formFromTemplate(stored);
    expect(form.language).toBe('pt_BR');
    expect(form.header_format).toBe('none');
    expect(form.card_format).toBe('image');
    const p = templatePayloadFromForm(form);
    expect(p.cards?.map((c) => c.body_text)).toEqual(['A', 'B']);
    expect(p.auth_options).toBeUndefined();
    expect(p.lto).toBeUndefined();
  });

  it('maps a library or AI draft text header and samples', () => {
    const form = formFromTemplate({
      name: 'welcome',
      category: 'Marketing',
      language: 'es',
      header_type: 'text',
      header_content: 'Hola',
      body_text: 'Hi {{1}}',
      sample_values: { body: ['Ana'] },
    });
    expect(form.template_kind).toBe('standard');
    expect(form.header_format).toBe('text');
    expect(form.header_content).toBe('Hola');
    expect(form.body_samples).toEqual(['Ana']);
    expect(form.auth_security).toBe(true);
  });
});

describe('review fixes R9-R11 and limited-time offer buttons', () => {
  it('R9: stored auth options without the security flag edit as off and stay off', () => {
    const form = formFromTemplate({
      name: 'otp',
      category: 'Authentication',
      language: 'en_US',
      template_kind: 'authentication',
      body_text: '',
      auth_options: { otp_type: 'COPY_CODE', code_expiration_minutes: 5 },
    } as Partial<MessageTemplate>);
    expect(form.auth_security).toBe(false);
    expect(templatePayloadFromForm(form).auth_options?.add_security_recommendation).toBe(false);
    // A brand-new authentication template still defaults to on.
    expect(formFromTemplate({ name: 'x', template_kind: 'authentication' }).auth_security).toBe(true);
  });

  it('R10: a synced carousel card handle (a CDN URL) is not carried into the form or payload', () => {
    const form = formFromTemplate({
      name: 'promo',
      category: 'Marketing',
      language: 'en_US',
      template_kind: 'carousel',
      body_text: 'Deals',
      cards: [0, 1].map((n) => ({
        header_type: 'image' as const,
        header_handle: `https://scontent.whatsapp.net/v/sample-${n}.jpg`,
        body_text: `Card ${n}`,
        buttons: [{ type: 'QUICK_REPLY' as const, text: 'Yes' }],
      })),
    } as Partial<MessageTemplate>);
    for (const c of form.cards) expect(c.header_handle).toBeUndefined();
    for (const c of templatePayloadFromForm(form).cards ?? []) {
      expect(c.header_handle).toBeUndefined();
      expect(c.header_media_url).toBeUndefined();
    }
  });

  it('R11: no card can be removed while any media upload runs', () => {
    expect(canRemoveCard(3, null)).toBe(true);
    expect(canRemoveCard(3, 2)).toBe(false);
    expect(canRemoveCard(3, 'header')).toBe(false);
    expect(canRemoveCard(2, null)).toBe(false);
  });

  it('a new limited-time offer starts with a URL button; copy code is sent first', () => {
    const lto = withTemplateKind(emptyTemplateForm(), 'limited_time_offer');
    expect(lto.buttons).toEqual([{ type: 'URL', text: '', url: '' }]);
    // Existing buttons are kept when switching.
    const kept = withTemplateKind(
      { ...emptyTemplateForm(), buttons: [{ type: 'COPY_CODE', text: 'Copy', example: 'X' }] },
      'limited_time_offer',
    );
    expect(kept.buttons.map((b) => b.type)).toEqual(['COPY_CODE']);

    const url = { type: 'URL' as const, text: 'Shop', url: 'https://shop.test' };
    const code = { type: 'COPY_CODE' as const, text: 'Copy', example: 'SAVE10' };
    expect(orderLimitedTimeOfferButtons([url, code])).toEqual([code, url]);
    const payload = templatePayloadFromForm({
      ...lto,
      name: 'offer',
      body_text: 'Sale',
      lto_text: 'Ends soon',
      buttons: [url, code],
    });
    expect(payload.buttons?.map((b) => b.type)).toEqual(['COPY_CODE', 'URL']);
    // Standard templates keep their order.
    const std = templatePayloadFromForm({ ...emptyTemplateForm(), buttons: [url, code] });
    expect(std.buttons?.map((b) => b.type)).toEqual(['URL', 'COPY_CODE']);
  });

  it('flags URL and phone buttons that still hold a library placeholder', () => {
    expect(hasLibraryPlaceholder({ type: 'URL', text: 'a', url: LIBRARY_URL_PLACEHOLDER })).toBe(true);
    expect(hasLibraryPlaceholder({ type: 'URL', text: 'a', url: 'https://example.com/x/{{1}}' })).toBe(true);
    expect(hasLibraryPlaceholder({ type: 'URL', text: 'a', url: 'https://myexample.com' })).toBe(false);
    expect(hasLibraryPlaceholder({ type: 'URL', text: 'a', url: '' })).toBe(false);
    expect(
      hasLibraryPlaceholder({ type: 'PHONE_NUMBER', text: 'a', phone_number: LIBRARY_PHONE_PLACEHOLDER }),
    ).toBe(true);
    expect(
      hasLibraryPlaceholder({ type: 'PHONE_NUMBER', text: 'a', phone_number: '+14155550100' }),
    ).toBe(false);
    expect(hasLibraryPlaceholder({ type: 'QUICK_REPLY', text: 'a' })).toBe(false);
  });
});
