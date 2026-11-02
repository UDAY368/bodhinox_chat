/**
 * Pure helpers behind the template manager and its editor: list tabs and
 * search, the quality "health" bucket, the editor's form state for every
 * template kind (to and from the submit/draft payload) and the carousel
 * card button-structure sync. Kept free of React and translations so they
 * are unit-tested in node.
 */

import type {
  CarouselCard,
  MessageTemplate,
  MessageTemplateStatus,
  TemplateButton,
  TemplateKind,
  TemplateSampleValues,
} from '@/types';
import {
  extractVariableIndices,
  orderLimitedTimeOfferButtons,
  TEMPLATE_LIMITS,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators';
import type { TemplateDraftInput } from './types';

// ---------------------------------------------------------------------------
// List tabs, search and health
// ---------------------------------------------------------------------------

export const TEMPLATE_TABS = [
  'all',
  'approved',
  'pending',
  'rejected',
  'drafts',
  'paused',
] as const;
export type TemplateTab = (typeof TEMPLATE_TABS)[number];

/** Which list tab (besides 'all') a stored status belongs to. */
export function templateTabOf(
  status: MessageTemplateStatus | null | undefined,
): Exclude<TemplateTab, 'all'> {
  switch (status) {
    case 'APPROVED':
      return 'approved';
    case 'PENDING':
    case 'IN_APPEAL':
    case 'PENDING_DELETION':
      return 'pending';
    case 'REJECTED':
      return 'rejected';
    case 'PAUSED':
    case 'DISABLED':
      return 'paused';
    default:
      // DRAFT and rows that never got a status are local-only drafts.
      return 'drafts';
  }
}

type ListRow = Pick<MessageTemplate, 'name' | 'status'>;

export function countTemplateTabs(
  templates: readonly ListRow[],
): Record<TemplateTab, number> {
  const counts = Object.fromEntries(TEMPLATE_TABS.map((k) => [k, 0])) as Record<
    TemplateTab,
    number
  >;
  for (const tpl of templates) {
    counts.all += 1;
    counts[templateTabOf(tpl.status)] += 1;
  }
  return counts;
}

/** Templates in `tab` whose name contains `query` (case-insensitive). */
export function filterTemplates<T extends ListRow>(
  templates: readonly T[],
  tab: TemplateTab,
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return templates.filter(
    (tpl) =>
      (tab === 'all' || templateTabOf(tpl.status) === tab) &&
      (!q || tpl.name.toLowerCase().includes(q)),
  );
}

export type TemplateHealth = 'green' | 'yellow' | 'red' | 'unknown';

/** Meta's quality rating → health bucket; anything else is 'unknown'. */
export function templateHealth(score: string | null | undefined): TemplateHealth {
  switch ((score ?? '').toUpperCase()) {
    case 'GREEN':
      return 'green';
    case 'YELLOW':
      return 'yellow';
    case 'RED':
      return 'red';
    default:
      return 'unknown';
  }
}

/**
 * A row that never reached Meta is edited as a draft (save draft / submit
 * by id); one with a meta_template_id changes only through PATCH.
 */
export function isLocalDraft(tpl: Pick<MessageTemplate, 'meta_template_id'>): boolean {
  return !tpl.meta_template_id;
}

// ---------------------------------------------------------------------------
// Editor form state
// ---------------------------------------------------------------------------

export type HeaderFormat =
  | 'none'
  | 'text'
  | 'image'
  | 'video'
  | 'document'
  | 'location';

export const HEADER_FORMATS_BY_KIND: Record<TemplateKind, readonly HeaderFormat[]> = {
  standard: ['none', 'text', 'image', 'video', 'document', 'location'],
  limited_time_offer: ['none', 'image', 'video'],
  carousel: ['none'],
  authentication: ['none'],
};

export const CATEGORIES_BY_KIND: Record<TemplateKind, readonly MessageTemplate['category'][]> = {
  standard: ['Marketing', 'Utility'],
  carousel: ['Marketing'],
  limited_time_offer: ['Marketing'],
  authentication: ['Authentication'],
};

export const BUTTON_TYPES_BY_KIND: Record<TemplateKind, readonly TemplateButton['type'][]> = {
  standard: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE'],
  limited_time_offer: ['URL', 'COPY_CODE'],
  carousel: [],
  authentication: [],
};

export const CARD_BUTTON_TYPES: readonly TemplateButton['type'][] = [
  'QUICK_REPLY',
  'URL',
  'PHONE_NUMBER',
];

export function maxButtonsFor(kind: TemplateKind): number {
  if (kind === 'limited_time_offer') return TEMPLATE_LIMITS.ltoMaxButtons;
  if (kind === 'standard') return TEMPLATE_LIMITS.maxButtonsTotal;
  return 0;
}

// The library's button placeholders (LIBRARY_URL_PLACEHOLDER and
// LIBRARY_PHONE_PLACEHOLDER in lib/whatsapp/template-library.ts; that
// module is server-side, so the values are matched here).
const PLACEHOLDER_PHONE_DIGITS = '10000000000';

/** True when a URL or phone button still holds a library placeholder. */
export function hasLibraryPlaceholder(button: TemplateButton): boolean {
  if (button.type === 'URL') {
    try {
      const host = new URL(button.url.trim()).hostname.toLowerCase();
      return host === 'example.com' || host.endsWith('.example.com');
    } catch {
      return false;
    }
  }
  if (button.type === 'PHONE_NUMBER') {
    return button.phone_number.replace(/\D/g, '') === PLACEHOLDER_PHONE_DIGITS;
  }
  return false;
}

export interface CardForm {
  header_media_url: string;
  /** Meta upload handle from an earlier submit; dropped when the URL changes. */
  header_handle?: string;
  body_text: string;
  body_samples: string[];
  buttons: TemplateButton[];
}

export interface TemplateFormData {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  template_kind: TemplateKind;
  header_format: HeaderFormat;
  header_content: string;
  header_media_url: string;
  header_sample: string;
  body_text: string;
  body_samples: string[];
  footer_text: string;
  buttons: TemplateButton[];
  card_format: CarouselCard['header_type'];
  cards: CardForm[];
  auth_security: boolean;
  /** Kept as typed text so an empty box means "no expiry". */
  auth_expiry: string;
  auth_button_text: string;
  lto_text: string;
  lto_has_expiration: boolean;
}

export function emptyButton(type: TemplateButton['type']): TemplateButton {
  switch (type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: '' };
    case 'URL':
      return { type: 'URL', text: '', url: '' };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: '', phone_number: '' };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: '', example: '' };
  }
}

export function emptyCard(buttonTypes: readonly TemplateButton['type'][] = ['QUICK_REPLY']): CardForm {
  return {
    header_media_url: '',
    body_text: '',
    body_samples: [],
    buttons: buttonTypes.map(emptyButton),
  };
}

export function emptyTemplateForm(language = 'en_US'): TemplateFormData {
  return {
    name: '',
    category: 'Marketing',
    language,
    template_kind: 'standard',
    header_format: 'none',
    header_content: '',
    header_media_url: '',
    header_sample: '',
    body_text: '',
    body_samples: [],
    footer_text: '',
    buttons: [],
    card_format: 'image',
    cards: [],
    auth_security: true,
    auth_expiry: '',
    auth_button_text: '',
    lto_text: '',
    lto_has_expiration: false,
  };
}

/**
 * Switch the editor to another kind: the category and header are forced
 * into what that kind allows and a carousel starts with the minimum number
 * of cards. Other typed values stay so switching back loses nothing; the
 * payload builder only reads the active kind's fields.
 */
export function withTemplateKind(form: TemplateFormData, kind: TemplateKind): TemplateFormData {
  const categories = CATEGORIES_BY_KIND[kind];
  const next: TemplateFormData = {
    ...form,
    template_kind: kind,
    category: categories.includes(form.category) ? form.category : categories[0],
    header_format: HEADER_FORMATS_BY_KIND[kind].includes(form.header_format)
      ? form.header_format
      : 'none',
  };
  // A limited-time offer starts with a URL button, the usual call to action.
  if (kind === 'limited_time_offer' && next.buttons.length === 0) {
    next.buttons = [emptyButton('URL')];
  }
  if (kind === 'carousel' && next.cards.length < TEMPLATE_LIMITS.carouselMinCards) {
    const types = next.cards[0]?.buttons.map((b) => b.type) ?? ['QUICK_REPLY'];
    const cards = [...next.cards];
    while (cards.length < TEMPLATE_LIMITS.carouselMinCards) cards.push(emptyCard(types));
    next.cards = cards;
  }
  return next;
}

/** Pad or trim a sample list to exactly `count` entries. */
export function resizeSamples(samples: readonly string[], count: number): string[] {
  const next = samples.slice(0, count);
  while (next.length < count) next.push('');
  return next;
}

type TemplateSource = TemplateDraftInput | Partial<MessageTemplate>;

/** Editor state for a stored row, a library entry or an AI draft. */
export function formFromTemplate(src: TemplateSource): TemplateFormData {
  const base = emptyTemplateForm(src.language || 'en_US');
  const kind: TemplateKind = src.template_kind ?? 'standard';
  const cards = src.cards ?? [];
  const auth = src.auth_options ?? undefined;
  const header = src.header_type ?? null;
  return {
    ...base,
    name: src.name ?? '',
    category: src.category ?? base.category,
    template_kind: kind,
    header_format: header ?? 'none',
    header_content: src.header_content ?? '',
    header_media_url: src.header_media_url ?? '',
    header_sample: src.sample_values?.header?.[0] ?? '',
    body_text: src.body_text ?? '',
    body_samples: [...(src.sample_values?.body ?? [])],
    footer_text: src.footer_text ?? '',
    buttons: [...(src.buttons ?? [])],
    card_format: cards[0]?.header_type ?? 'image',
    cards: cards.map((c) => ({
      header_media_url: c.header_media_url ?? '',
      // A stored card handle is not reused: for a synced row it is Meta's
      // sample CDN URL, not an upload handle, and the editor never shows
      // it. Without one the card's media is uploaded again, like the
      // standard header.
      body_text: c.body_text ?? '',
      body_samples: [...(c.sample_values?.body ?? [])],
      buttons: [...(c.buttons ?? [])],
    })),
    // Sync stores the flag only when Meta reports it on, so a missing key
    // on stored auth options means off, never the new-template default.
    auth_security: auth ? auth.add_security_recommendation === true : base.auth_security,
    auth_expiry:
      auth?.code_expiration_minutes != null ? String(auth.code_expiration_minutes) : '',
    auth_button_text: auth?.button_text ?? '',
    lto_text: src.lto?.text ?? '',
    lto_has_expiration: src.lto?.has_expiration ?? false,
  };
}

/**
 * Samples for the variables `text` actually has (rows left over from a
 * deleted variable are dropped), or undefined when all are blank.
 */
function trimmedSamples(samples: readonly string[], text: string): string[] | undefined {
  const sized = resizeSamples(samples, extractVariableIndices(text).length);
  return sized.some((v) => v.trim()) ? sized.map((v) => v.trim()) : undefined;
}

/**
 * The submit / draft / PATCH body for the form. Only the active kind's
 * fields are sent, so a value left on a hidden field never trips the
 * server's "field not allowed for this kind" check.
 */
export function templatePayloadFromForm(form: TemplateFormData): TemplatePayload {
  const kind = form.template_kind;
  const base: TemplatePayload = {
    name: form.name.trim(),
    category: form.category,
    language: form.language.trim() || 'en_US',
    template_kind: kind,
    body_text: kind === 'authentication' ? '' : form.body_text.trim(),
  };

  if (kind === 'authentication') {
    const expiry = form.auth_expiry.trim();
    return {
      ...base,
      auth_options: {
        otp_type: 'COPY_CODE',
        add_security_recommendation: form.auth_security,
        ...(expiry ? { code_expiration_minutes: Number(expiry) } : {}),
        ...(form.auth_button_text.trim()
          ? { button_text: form.auth_button_text.trim() }
          : {}),
      },
    };
  }

  const sample_values: TemplateSampleValues = {};
  const body = trimmedSamples(form.body_samples, form.body_text);
  if (body) sample_values.body = body;

  if (kind === 'carousel') {
    return {
      ...base,
      ...(body ? { sample_values } : {}),
      cards: form.cards.map((c): CarouselCard => {
        const cardBody = trimmedSamples(c.body_samples, c.body_text);
        const url = c.header_media_url.trim();
        return {
          header_type: form.card_format,
          ...(url ? { header_media_url: url } : {}),
          ...(c.header_handle ? { header_handle: c.header_handle } : {}),
          body_text: c.body_text.trim(),
          ...(cardBody ? { sample_values: { body: cardBody } } : {}),
          buttons: c.buttons,
        };
      }),
    };
  }

  const format = HEADER_FORMATS_BY_KIND[kind].includes(form.header_format)
    ? form.header_format
    : 'none';
  if (
    format === 'text' &&
    form.header_sample.trim() &&
    extractVariableIndices(form.header_content).length > 0
  ) {
    sample_values.header = [form.header_sample.trim()];
  }
  const payload: TemplatePayload = {
    ...base,
    ...(format !== 'none' ? { header_type: format } : {}),
    ...(format === 'text' ? { header_content: form.header_content.trim() } : {}),
    ...(format === 'image' || format === 'video' || format === 'document'
      ? form.header_media_url.trim()
        ? { header_media_url: form.header_media_url.trim() }
        : {}
      : {}),
    ...(form.buttons.length > 0
      ? { buttons: kind === 'limited_time_offer' ? orderLimitedTimeOfferButtons(form.buttons) : form.buttons }
      : {}),
    ...(Object.keys(sample_values).length > 0 ? { sample_values } : {}),
  };
  if (kind === 'limited_time_offer') {
    payload.lto = { text: form.lto_text.trim(), has_expiration: form.lto_has_expiration };
  } else if (form.footer_text.trim()) {
    payload.footer_text = form.footer_text.trim();
  }
  return payload;
}

/** Live-preview input for the form (same shape the dialogs hand back). */
export function previewFromForm(form: TemplateFormData): TemplateDraftInput {
  const p = templatePayloadFromForm(form);
  return { ...p, template_kind: form.template_kind };
}

// ---------------------------------------------------------------------------
// Carousel cards: every card has the same button types in the same order
// ---------------------------------------------------------------------------

/** Append a card that mirrors the first card's button slots, emptied. */
export function addCard(cards: readonly CardForm[]): CardForm[] {
  if (cards.length >= TEMPLATE_LIMITS.carouselMaxCards) return [...cards];
  const types = cards[0]?.buttons.map((b) => b.type) ?? ['QUICK_REPLY'];
  return [...cards, emptyCard(types)];
}

/**
 * Whether a card can be removed now. A running upload lands on its card
 * by index, so removing any card while one runs would send the file to
 * the wrong card (or drop it).
 */
export function canRemoveCard(cardCount: number, uploading: 'header' | number | null): boolean {
  return uploading === null && cardCount > TEMPLATE_LIMITS.carouselMinCards;
}

export function removeCard(cards: readonly CardForm[], index: number): CardForm[] {
  if (cards.length <= TEMPLATE_LIMITS.carouselMinCards) return [...cards];
  return cards.filter((_, i) => i !== index);
}

/** Add a button slot of `type` to every card. */
export function addCardButton(
  cards: readonly CardForm[],
  type: TemplateButton['type'] = 'QUICK_REPLY',
): CardForm[] {
  if ((cards[0]?.buttons.length ?? 0) >= TEMPLATE_LIMITS.cardMaxButtons) return [...cards];
  return cards.map((c) => ({ ...c, buttons: [...c.buttons, emptyButton(type)] }));
}

/** Remove button slot `slot` from every card. */
export function removeCardButton(cards: readonly CardForm[], slot: number): CardForm[] {
  return cards.map((c) => ({ ...c, buttons: c.buttons.filter((_, i) => i !== slot) }));
}

/** Change the type of button slot `slot` on every card (values reset). */
export function setCardButtonType(
  cards: readonly CardForm[],
  slot: number,
  type: TemplateButton['type'],
): CardForm[] {
  return cards.map((c) => ({
    ...c,
    buttons: c.buttons.map((b, i) => (i === slot ? emptyButton(type) : b)),
  }));
}

export type ButtonPatch = {
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string;
};

/**
 * Apply only the fields valid for the button's own type, keeping the
 * discriminant pinned (a URL patch on a quick reply is ignored).
 */
export function patchButton(button: TemplateButton, patch: ButtonPatch): TemplateButton {
  const text = patch.text !== undefined ? { text: patch.text } : {};
  switch (button.type) {
    case 'QUICK_REPLY':
      return { ...button, ...text };
    case 'URL':
      return {
        ...button,
        ...text,
        ...(patch.url !== undefined && { url: patch.url }),
        ...(patch.example !== undefined && { example: patch.example }),
      };
    case 'PHONE_NUMBER':
      return {
        ...button,
        ...text,
        ...(patch.phone_number !== undefined && { phone_number: patch.phone_number }),
      };
    case 'COPY_CODE':
      return {
        ...button,
        ...text,
        ...(patch.example !== undefined && { example: patch.example }),
      };
  }
}
