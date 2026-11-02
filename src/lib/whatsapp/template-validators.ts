/**
 * Pure validators for message templates, run BEFORE the Meta submit
 * call so a misconfigured template fails at save time (with a specific
 * field-level error) rather than at the Meta API boundary (where the
 * error is a generic 400 + opaque rejection_reason hours later).
 *
 * Every validator throws `Error(message)` — callers catch and surface
 * to the UI. Caps follow Meta's published limits for the Cloud API
 * template surface (v21.0):
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 *
 * Per-element button validation lives here rather than as a JSONB CHECK
 * because Postgres CHECK constraints can't contain subqueries, and
 * generic CHECK violations don't give users an actionable error
 * ("button #3 has no `text`" beats "constraint violated").
 */

import type {
  AuthTemplateOptions,
  CarouselCard,
  LimitedTimeOffer,
  MessageTemplate,
  TemplateButton,
  TemplateKind,
  TemplateSampleValues,
} from '@/types';
import { getT } from '@/lib/i18n/translate';
import { LIBRARY_PHONE_PLACEHOLDER, LIBRARY_URL_PLACEHOLDER } from './template-library';

const t = getT('Validation.templates');

export const TEMPLATE_LIMITS = {
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
  buttonTextMaxLength: 25,
  maxButtonsTotal: 10,
  maxUrlButtons: 2,
  maxPhoneButtons: 1,
  maxCopyCodeButtons: 1,
  /** Meta: lowercase a-z, digits, underscore. Up to 512 chars. */
  nameRegex: /^[a-z0-9_]{1,512}$/,
  carouselMinCards: 2,
  carouselMaxCards: 10,
  cardBodyMaxLength: 160,
  cardMinButtons: 1,
  cardMaxButtons: 2,
  authMinExpiryMinutes: 1,
  authMaxExpiryMinutes: 90,
  ltoTextMaxLength: 16,
  ltoBodyMaxLength: 600,
  ltoMaxButtons: 2,
} as const;

export const TEMPLATE_KINDS: readonly TemplateKind[] = [
  'standard',
  'carousel',
  'authentication',
  'limited_time_offer',
];

export interface TemplatePayload {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  header_type?: MessageTemplate['header_type'];
  header_content?: string;
  header_media_url?: string;
  header_handle?: string;
  body_text: string;
  footer_text?: string;
  buttons?: TemplateButton[];
  sample_values?: TemplateSampleValues;
  /** Absent (or null from a stored row) means 'standard'. */
  template_kind?: TemplateKind | null;
  cards?: CarouselCard[] | null;
  auth_options?: AuthTemplateOptions | null;
  lto?: LimitedTimeOffer | null;
}

export function validateTemplateName(name: string): void {
  if (!name) throw new Error(t('nameRequired'));
  if (!TEMPLATE_LIMITS.nameRegex.test(name)) {
    throw new Error(t('nameInvalid'));
  }
}

/**
 * Extract sorted, deduplicated {{N}} indices from a string. Returns
 * `[1, 2, 4]` for `"Hi {{1}} {{2}}, item {{4}}"`.
 */
export function extractVariableIndices(text: string): number[] {
  const matches = text.matchAll(/\{\{(\d+)\}\}/g);
  const set = new Set<number>();
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Meta requires contiguous, 1-indexed variables. `{{1}} {{3}}` is
 * invalid — it must be `{{1}} {{2}}`.
 */
function assertBodyContiguous(indices: number[]): void {
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i + 1) {
      throw new Error(
        t('bodyNotContiguous', {
          first: '{{1}}',
          found: indices.map((n) => `{{${n}}}`).join(', '),
        }),
      );
    }
  }
}

/**
 * Meta rejects a body (or carousel card body) whose trimmed text starts
 * or ends with a variable. Punctuation after the last variable is fine.
 */
function assertNoEdgeVariable(text: string): void {
  const trimmed = text.trim();
  if (/^\{\{\d+\}\}/.test(trimmed) || /\{\{\d+\}\}$/.test(trimmed)) {
    throw new Error(t('bodyVariableAtEdge'));
  }
}

export function validateBody(bodyText: string): number[] {
  if (!bodyText.trim()) throw new Error(t('bodyRequired'));
  if (bodyText.length > TEMPLATE_LIMITS.bodyMaxLength) {
    throw new Error(
      t('bodyTooLong', { max: TEMPLATE_LIMITS.bodyMaxLength, got: bodyText.length }),
    );
  }
  const indices = extractVariableIndices(bodyText);
  assertBodyContiguous(indices);
  assertNoEdgeVariable(bodyText);
  return indices;
}

export function validateFooter(footerText: string | undefined): void {
  if (!footerText) return;
  if (footerText.length > TEMPLATE_LIMITS.footerMaxLength) {
    throw new Error(
      t('footerTooLong', { max: TEMPLATE_LIMITS.footerMaxLength, got: footerText.length }),
    );
  }
  if (extractVariableIndices(footerText).length > 0) {
    throw new Error(t('footerNoVariables', { placeholder: '{{N}}' }));
  }
}

export interface HeaderValidationResult {
  /** number of {{N}} placeholders in a TEXT header — 0 or 1. */
  variableCount: number;
}

export function validateHeader(
  payload: Pick<
    TemplatePayload,
    'header_type' | 'header_content' | 'header_media_url' | 'header_handle'
  >,
): HeaderValidationResult {
  const { header_type, header_content, header_media_url, header_handle } = payload;
  if (!header_type) return { variableCount: 0 };

  // A location header has no authored content: the coordinates are sent
  // with each message (template-send-builder).
  if (header_type === 'location') {
    if (header_content || header_media_url || header_handle) {
      throw new Error(t('locationHeaderNoContent'));
    }
    return { variableCount: 0 };
  }

  if (header_type === 'text') {
    if (!header_content || !header_content.trim()) {
      throw new Error(t('headerTextRequired'));
    }
    if (header_content.length > TEMPLATE_LIMITS.headerTextMaxLength) {
      throw new Error(
        t('headerTextTooLong', {
          max: TEMPLATE_LIMITS.headerTextMaxLength,
          got: header_content.length,
        }),
      );
    }
    const indices = extractVariableIndices(header_content);
    if (indices.length > 1) {
      throw new Error(
        t('headerTooManyVariables', { count: indices.length }),
      );
    }
    if (indices.length === 1 && indices[0] !== 1) {
      throw new Error(t('headerVariableMustBeFirst', { var: '{{1}}' }));
    }
    return { variableCount: indices.length };
  }

  // image / video / document need either a public URL or a Resumable
  // Upload handle. Either one — Meta accepts both example forms.
  if (!header_media_url && !header_handle) {
    throw new Error(
      t('mediaHeaderRequiresSource', { type: header_type }),
    );
  }
  if (header_media_url) {
    try {
      // Uploaded samples remain private app references. The server
      // authorizes their account and signs them immediately before use.
      const u = header_media_url.startsWith('/api/media/object?')
        ? new URL(header_media_url, 'https://media.invalid')
        : new URL(header_media_url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error(t('headerMediaUrlScheme'));
      }
    } catch {
      throw new Error(t('headerMediaUrlInvalid'));
    }
  }
  return { variableCount: 0 };
}

function countButtonsByType(
  buttons: TemplateButton[],
): Record<TemplateButton['type'], number> {
  const counts: Record<TemplateButton['type'], number> = {
    QUICK_REPLY: 0,
    URL: 0,
    PHONE_NUMBER: 0,
    COPY_CODE: 0,
  };
  for (const b of buttons) counts[b.type]++;
  return counts;
}

/**
 * The template library prefills URL buttons with https://example.com and
 * phone buttons with +10000000000 so users see what to replace. Drafts
 * may keep them; submitting to Meta must not. The URL check matches the
 * placeholder however it is cased or slashed, but not a real path on it.
 */
function isLibraryPlaceholderUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    const placeholder = new URL(LIBRARY_URL_PLACEHOLDER);
    return (
      u.hostname.replace(/^www\./, '') === placeholder.hostname &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

function isLibraryPlaceholderPhone(phone: string): boolean {
  return phone.replace(/\D/g, '') === LIBRARY_PHONE_PLACEHOLDER.replace(/\D/g, '');
}

export function validateButtons(buttons: TemplateButton[] | undefined): void {
  if (!buttons || buttons.length === 0) return;
  if (buttons.length > TEMPLATE_LIMITS.maxButtonsTotal) {
    throw new Error(
      t('tooManyButtons', { max: TEMPLATE_LIMITS.maxButtonsTotal, got: buttons.length }),
    );
  }

  const counts = countButtonsByType(buttons);
  if (counts.URL > TEMPLATE_LIMITS.maxUrlButtons) {
    throw new Error(
      t('tooManyUrlButtons', { max: TEMPLATE_LIMITS.maxUrlButtons, got: counts.URL }),
    );
  }
  if (counts.PHONE_NUMBER > TEMPLATE_LIMITS.maxPhoneButtons) {
    throw new Error(
      t('tooManyPhoneButtons', {
        max: TEMPLATE_LIMITS.maxPhoneButtons,
        got: counts.PHONE_NUMBER,
      }),
    );
  }
  if (counts.COPY_CODE > TEMPLATE_LIMITS.maxCopyCodeButtons) {
    throw new Error(
      t('tooManyCopyCodeButtons', {
        max: TEMPLATE_LIMITS.maxCopyCodeButtons,
        got: counts.COPY_CODE,
      }),
    );
  }

  // Meta rule: QUICK_REPLY buttons must be contiguous — they can't be
  // interleaved with CTA buttons. Easiest check: walk the array; once
  // we leave the QUICK_REPLY block, we must not see another.
  let sawNonQR = false;
  for (const b of buttons) {
    if (b.type === 'QUICK_REPLY') {
      if (sawNonQR) {
        throw new Error(
          t('quickReplyInterleaved'),
        );
      }
    } else {
      sawNonQR = true;
    }
  }

  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    if (!b.text?.trim()) {
      throw new Error(t('buttonMissingText', { n: i + 1, type: b.type }));
    }
    if (b.text.length > TEMPLATE_LIMITS.buttonTextMaxLength) {
      throw new Error(
        t('buttonTextTooLong', { n: i + 1, max: TEMPLATE_LIMITS.buttonTextMaxLength }),
      );
    }
    switch (b.type) {
      case 'URL': {
        if (!b.url?.trim()) {
          throw new Error(t('urlButtonMissingUrl', { n: i + 1 }));
        }
        try {
          new URL(b.url);
        } catch {
          throw new Error(t('urlButtonInvalidUrl', { n: i + 1 }));
        }
        if (isLibraryPlaceholderUrl(b.url)) {
          throw new Error(
            t('buttonPlaceholderUrl', { n: i + 1, url: LIBRARY_URL_PLACEHOLDER }),
          );
        }
        const urlVars = extractVariableIndices(b.url);
        if (urlVars.length > 1) {
          throw new Error(
            t('urlButtonTooManyVariables', { n: i + 1 }),
          );
        }
        if (urlVars.length === 1) {
          if (urlVars[0] !== 1) {
            throw new Error(
              t('urlButtonVariableMustBeFirst', { n: i + 1, var: '{{1}}' }),
            );
          }
          if (!b.example?.trim()) {
            throw new Error(
              t('urlButtonNeedsExample', { n: i + 1, var: '{{1}}' }),
            );
          }
        }
        break;
      }
      case 'PHONE_NUMBER':
        if (!b.phone_number?.trim()) {
          throw new Error(
            t('phoneButtonMissingNumber', { n: i + 1 }),
          );
        }
        if (isLibraryPlaceholderPhone(b.phone_number)) {
          throw new Error(
            t('buttonPlaceholderPhone', { n: i + 1, phone: LIBRARY_PHONE_PLACEHOLDER }),
          );
        }
        break;
      case 'COPY_CODE':
        if (!b.example?.trim()) {
          throw new Error(
            t('copyCodeButtonMissingExample', { n: i + 1 }),
          );
        }
        break;
    }
  }
}

/**
 * Sample values must be supplied 1:1 with the variables in the body
 * (and header, if it has one). Meta uses these for human review.
 */
export function validateSampleValues(
  payload: TemplatePayload,
  bodyVarCount: number,
  headerVarCount: number,
): void {
  const samples = payload.sample_values ?? {};
  const body = samples.body ?? [];
  const header = samples.header ?? [];

  if (body.length !== bodyVarCount) {
    throw new Error(
      t('bodySampleCountMismatch', { count: bodyVarCount, got: body.length }),
    );
  }
  if (header.length !== headerVarCount) {
    throw new Error(
      t('headerSampleCountMismatch', { count: headerVarCount, got: header.length }),
    );
  }
  for (let i = 0; i < body.length; i++) {
    if (!body[i] || !body[i].trim()) {
      throw new Error(t('bodySampleEmpty', { n: i + 1 }));
    }
  }
  for (let i = 0; i < header.length; i++) {
    if (!header[i] || !header[i].trim()) {
      throw new Error(t('headerSampleEmpty', { n: i + 1 }));
    }
  }
}

/** Resolve the stored or submitted kind; anything absent is 'standard'. */
export function templateKindOf(payload: {
  template_kind?: TemplateKind | null;
}): TemplateKind {
  return payload.template_kind ?? 'standard';
}

function present(value: unknown): boolean {
  if (value == null) return false;
  return !Array.isArray(value) || value.length > 0;
}

/** Fields that belong to one kind are rejected on every other kind. */
function assertNoForeignKindFields(payload: TemplatePayload, kind: TemplateKind): void {
  const owners: [keyof TemplatePayload, TemplateKind][] = [
    ['cards', 'carousel'],
    ['auth_options', 'authentication'],
    ['lto', 'limited_time_offer'],
  ];
  for (const [field, owner] of owners) {
    if (owner !== kind && present(payload[field])) {
      throw new Error(t('kindFieldNotAllowed', { field }));
    }
  }
}

/** Re-throw a nested validator's message prefixed with the card number. */
function inCard(n: number, run: () => void): void {
  try {
    run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(t('cardError', { n, message }));
  }
}

function validateStandard(payload: TemplatePayload) {
  if (payload.header_type === 'location' && payload.category === 'Authentication') {
    throw new Error(t('locationHeaderCategory'));
  }
  const bodyVars = validateBody(payload.body_text);
  validateFooter(payload.footer_text);
  const headerResult = validateHeader(payload);
  validateButtons(payload.buttons);
  validateSampleValues(payload, bodyVars.length, headerResult.variableCount);
  return {
    bodyVarCount: bodyVars.length,
    headerVarCount: headerResult.variableCount,
  };
}

const CARD_BUTTON_TYPES: ReadonlySet<TemplateButton['type']> = new Set([
  'QUICK_REPLY',
  'URL',
  'PHONE_NUMBER',
]);

function validateCard(card: CarouselCard, format: CarouselCard['header_type']): void {
  if (card.header_type !== 'image' && card.header_type !== 'video') {
    throw new Error(t('cardHeaderType'));
  }
  if (card.header_type !== format) {
    throw new Error(t('cardHeaderMismatch', { format }));
  }
  validateHeader(card);

  const body = card.body_text ?? '';
  if (!body.trim()) throw new Error(t('cardBodyRequired'));
  if (body.length > TEMPLATE_LIMITS.cardBodyMaxLength) {
    throw new Error(
      t('cardBodyTooLong', { max: TEMPLATE_LIMITS.cardBodyMaxLength, got: body.length }),
    );
  }
  const indices = extractVariableIndices(body);
  assertBodyContiguous(indices);
  assertNoEdgeVariable(body);
  validateSampleValues(
    { sample_values: { body: card.sample_values?.body } } as TemplatePayload,
    indices.length,
    0,
  );

  const buttons = card.buttons ?? [];
  if (
    buttons.length < TEMPLATE_LIMITS.cardMinButtons ||
    buttons.length > TEMPLATE_LIMITS.cardMaxButtons
  ) {
    throw new Error(
      t('cardButtonCount', {
        min: TEMPLATE_LIMITS.cardMinButtons,
        max: TEMPLATE_LIMITS.cardMaxButtons,
        got: buttons.length,
      }),
    );
  }
  buttons.forEach((b, i) => {
    if (!CARD_BUTTON_TYPES.has(b.type)) {
      throw new Error(t('cardButtonType', { n: i + 1, type: b.type }));
    }
  });
  validateButtons(buttons);
}

function validateCarousel(payload: TemplatePayload) {
  if (payload.category !== 'Marketing') throw new Error(t('carouselCategory'));
  if (payload.header_type) throw new Error(t('carouselNoHeader'));
  if (payload.footer_text) throw new Error(t('carouselNoFooter'));
  if (present(payload.buttons)) throw new Error(t('carouselNoButtons'));

  const bodyVars = validateBody(payload.body_text);
  validateSampleValues(payload, bodyVars.length, 0);

  const cards = payload.cards ?? [];
  if (
    cards.length < TEMPLATE_LIMITS.carouselMinCards ||
    cards.length > TEMPLATE_LIMITS.carouselMaxCards
  ) {
    throw new Error(
      t('carouselCardCount', {
        min: TEMPLATE_LIMITS.carouselMinCards,
        max: TEMPLATE_LIMITS.carouselMaxCards,
        got: cards.length,
      }),
    );
  }
  const format = cards[0].header_type;
  const shape = (card: CarouselCard) => (card.buttons ?? []).map((b) => b.type).join(',');
  cards.forEach((card, i) => {
    inCard(i + 1, () => {
      validateCard(card, format);
      // Cards render side by side, so Meta requires their buttons to line up.
      if (shape(card) !== shape(cards[0])) throw new Error(t('cardButtonsMismatch'));
    });
  });
  return { bodyVarCount: bodyVars.length, headerVarCount: 0 };
}

/**
 * Meta writes an authentication template's body itself (the code plus
 * optional security line), so `body_text` is not authored and is ignored
 * here. The one-time code is that body's single variable.
 */
function validateAuthentication(payload: TemplatePayload) {
  if (payload.category !== 'Authentication') throw new Error(t('authCategory'));
  if (payload.header_type) throw new Error(t('authNoHeader'));
  if (payload.footer_text) throw new Error(t('authNoFooter'));
  if (present(payload.buttons)) throw new Error(t('authNoButtons'));

  const options = payload.auth_options;
  if (!options) throw new Error(t('authOptionsRequired'));
  if (options.otp_type !== 'COPY_CODE') throw new Error(t('authOtpType'));
  const expiry = options.code_expiration_minutes;
  if (
    expiry != null &&
    (!Number.isInteger(expiry) ||
      expiry < TEMPLATE_LIMITS.authMinExpiryMinutes ||
      expiry > TEMPLATE_LIMITS.authMaxExpiryMinutes)
  ) {
    throw new Error(
      t('authExpiryRange', {
        min: TEMPLATE_LIMITS.authMinExpiryMinutes,
        max: TEMPLATE_LIMITS.authMaxExpiryMinutes,
      }),
    );
  }
  if (
    options.add_security_recommendation != null &&
    typeof options.add_security_recommendation !== 'boolean'
  ) {
    throw new Error(t('authSecurityFlag'));
  }
  if (options.button_text != null) {
    if (typeof options.button_text !== 'string' || !options.button_text.trim()) {
      throw new Error(t('authButtonTextEmpty'));
    }
    if (options.button_text.length > TEMPLATE_LIMITS.buttonTextMaxLength) {
      throw new Error(
        t('authButtonTextTooLong', {
          max: TEMPLATE_LIMITS.buttonTextMaxLength,
          got: options.button_text.length,
        }),
      );
    }
  }
  return { bodyVarCount: 1, headerVarCount: 0 };
}

/**
 * Meta's limited-time offer layout: the copy-code button first, then the
 * URL button. Returns a new array with any COPY_CODE buttons moved to the
 * front; the rest keep their order. Callers apply it before saving so the
 * send-time button indices match what Meta approved.
 */
export function orderLimitedTimeOfferButtons(buttons: readonly TemplateButton[]): TemplateButton[] {
  return [
    ...buttons.filter((b) => b.type === 'COPY_CODE'),
    ...buttons.filter((b) => b.type !== 'COPY_CODE'),
  ];
}

function validateLimitedTimeOffer(payload: TemplatePayload) {
  if (payload.category !== 'Marketing') throw new Error(t('ltoCategory'));

  const lto = payload.lto;
  if (!lto || typeof lto.text !== 'string' || !lto.text.trim()) {
    throw new Error(t('ltoTextRequired'));
  }
  if (lto.text.length > TEMPLATE_LIMITS.ltoTextMaxLength) {
    throw new Error(
      t('ltoTextTooLong', { max: TEMPLATE_LIMITS.ltoTextMaxLength, got: lto.text.length }),
    );
  }
  if (typeof lto.has_expiration !== 'boolean') throw new Error(t('ltoExpirationFlag'));

  if (payload.header_type && payload.header_type !== 'image' && payload.header_type !== 'video') {
    throw new Error(t('ltoHeaderType'));
  }
  if (payload.footer_text) throw new Error(t('ltoNoFooter'));
  const bodyLength = (payload.body_text ?? '').length;
  if (bodyLength > TEMPLATE_LIMITS.ltoBodyMaxLength) {
    throw new Error(
      t('ltoBodyTooLong', { max: TEMPLATE_LIMITS.ltoBodyMaxLength, got: bodyLength }),
    );
  }
  const bodyVars = validateBody(payload.body_text);
  const headerResult = validateHeader(payload);

  const buttons = payload.buttons ?? [];
  if (buttons.length > TEMPLATE_LIMITS.ltoMaxButtons) {
    throw new Error(
      t('ltoTooManyButtons', { max: TEMPLATE_LIMITS.ltoMaxButtons, got: buttons.length }),
    );
  }
  const copyCodes = buttons.filter((b) => b.type === 'COPY_CODE').length;
  const urls = buttons.filter((b) => b.type === 'URL').length;
  if (copyCodes + urls !== buttons.length || copyCodes > 1 || urls > 1) {
    throw new Error(t('ltoButtonTypes'));
  }
  if (lto.has_expiration && copyCodes === 0) throw new Error(t('ltoCopyCodeRequired'));
  // Meta: the URL button is required; with a copy-code button the code
  // sits at index 0 and the URL at index 1 (orderLimitedTimeOfferButtons).
  if (urls !== 1) throw new Error(t('ltoUrlButtonRequired'));
  if (copyCodes === 1 && buttons[0].type !== 'COPY_CODE') {
    throw new Error(t('ltoCopyCodeFirst'));
  }
  validateButtons(buttons);
  validateSampleValues(payload, bodyVars.length, headerResult.variableCount);
  return { bodyVarCount: bodyVars.length, headerVarCount: headerResult.variableCount };
}

/**
 * Run every validator for the payload's kind. Throws on the first
 * failure with a specific, field-level message. Returns the variable
 * counts so callers can reuse them when building the Meta components
 * payload (an authentication template reports its one code variable).
 */
export function validateTemplatePayload(payload: TemplatePayload): {
  bodyVarCount: number;
  headerVarCount: number;
} {
  validateTemplateName(payload.name);
  if (!payload.language?.trim()) {
    throw new Error(t('languageRequired'));
  }
  const kind = templateKindOf(payload);
  if (!TEMPLATE_KINDS.includes(kind)) {
    throw new Error(t('kindInvalid', { kind: String(kind) }));
  }
  assertNoForeignKindFields(payload, kind);
  if (payload.header_type === 'location' && kind !== 'standard') {
    throw new Error(t('locationHeaderCategory'));
  }
  switch (kind) {
    case 'carousel':
      return validateCarousel(payload);
    case 'authentication':
      return validateAuthentication(payload);
    case 'limited_time_offer':
      return validateLimitedTimeOffer(payload);
    default:
      return validateStandard(payload);
  }
}
