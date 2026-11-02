/**
 * Build the Meta `components` array used by POST /{phone_number_id}/messages
 * when sending an APPROVED template.
 *
 * Distinct from `template-components.ts` — that module builds the
 * `components` for TEMPLATE CREATION (where you describe headers,
 * footers, buttons, examples). This module builds the per-send
 * `components` (where you fill in variable values and supply the
 * actual media link or button URL suffix for THIS specific delivery).
 *
 * Auto-fills as much as possible from the template row so callers
 * only need to supply values for the variable-bearing fields:
 *
 *   - Static IMAGE/VIDEO/DOCUMENT headers ride along automatically
 *     using the template's `header_media_url` (or `header_handle`).
 *     Meta requires the media component on every send even though
 *     the URL hasn't changed since approval.
 *   - TEXT headers with `{{1}}` need `headerText` from the caller.
 *   - Body variables come in as `body: string[]`, indexed by {{N}}.
 *   - URL buttons with `{{1}}` need `buttonUrlParams[i]` keyed by
 *     button index. URL buttons without variables, plus QUICK_REPLY
 *     and PHONE_NUMBER buttons, don't need send-time parameters.
 *   - COPY_CODE buttons need the actual code to display. We fall
 *     back to the template's `example` value if the caller doesn't
 *     override — that matches the most common use case (a static
 *     promo code) without forcing UI work.
 *
 * Validation throws here (not at the Meta API boundary) so a missing
 * sample surfaces as "Header text variable {{1}} requires a value",
 * not a 400 from Meta that doesn't say which field broke.
 */

import type {
  CarouselCard,
  MessageTemplate,
  TemplateButton,
} from '@/types';
import { extractVariableIndices, templateKindOf } from './template-validators';
import { getT } from '@/lib/i18n/translate';

const t = getT('Validation.templates');

export interface SendTimeParams {
  /** Values for body {{1}}, {{2}}, … indexed by variable position. */
  body?: string[];
  /** Value for TEXT-header {{1}}, when the header has a variable. */
  headerText?: string;
  /** Override the template's static media URL for this send. */
  headerMediaUrl?: string;
  /** Alternative: send the media by Meta media id (from prior upload). */
  headerMediaId?: string;
  /**
   * Per-button overrides keyed by the button's index in the
   * template's `buttons` array. Used for URL buttons with a {{1}}
   * suffix and for COPY_CODE buttons whose example you want to
   * override at send time.
   */
  buttonParams?: Record<number, string>;
  /** Required for a LOCATION header: the place shown above the body. */
  location?: LocationSendParams;
  /**
   * Authentication templates: the one-time code. It fills the body's
   * {{1}} and the copy-code button, which Meta requires to match.
   */
  authCode?: string;
  /**
   * Limited-time offer: when the offer ends, in Unix epoch milliseconds.
   * Required when the template's offer has an expiration.
   */
  offerExpirationTimeMs?: number;
  /**
   * Code for a COPY_CODE button (limited-time offers and standard
   * templates). `buttonParams[i]` still wins for that button; the
   * button's stored example is the fallback.
   */
  couponCode?: string;
  /** Carousel: per-card values, by card position. */
  cards?: CarouselCardSendParams[];
  /**
   * FLOW buttons: the one-time flow token for this send, keyed by the
   * button's index. A FLOW button without one is sent without a token
   * (Meta's default), so its submission cannot be tied to a session.
   */
  flowTokens?: Record<number, string>;
}

export interface LocationSendParams {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface CarouselCardSendParams {
  /** Override the card's stored header_media_url for this send. */
  headerMediaUrl?: string;
  /** Alternative: a Meta media id from a prior /media upload. */
  headerMediaId?: string;
  /** Values for the card body's {{1}}, {{2}}, … */
  body?: string[];
  /**
   * Per-button values keyed by the button's index in the card: a URL
   * button's {{1}} suffix or a quick reply's payload (defaults to the
   * button text).
   */
  buttonParams?: Record<number, string>;
}

/** Longest one-time code Meta accepts for authentication templates. */
export const AUTH_CODE_MAX_LENGTH = 15;

type MetaSendButtonComponent = {
  type: 'button';
  sub_type: 'url' | 'quick_reply' | 'copy_code' | 'flow';
  index: string;
  parameters: MetaSendParameter[];
};

export type MetaSendComponent =
  | { type: 'header'; parameters: MetaSendParameter[] }
  | { type: 'body'; parameters: MetaSendParameter[] }
  | MetaSendButtonComponent
  | {
      type: 'limited_time_offer';
      parameters: {
        type: 'limited_time_offer';
        limited_time_offer: { expiration_time_ms: number };
      }[];
    }
  | {
      type: 'carousel';
      cards: { card_index: number; components: MetaSendComponent[] }[];
    };

type MetaSendParameter =
  | { type: 'text'; text: string }
  | { type: 'image'; image: { link?: string; id?: string } }
  | { type: 'video'; video: { link?: string; id?: string } }
  | { type: 'document'; document: { link?: string; id?: string } }
  | {
      type: 'location';
      location: { latitude: number; longitude: number; name?: string; address?: string };
    }
  | { type: 'coupon_code'; coupon_code: string }
  | { type: 'payload'; payload: string }
  | { type: 'action'; action: { flow_token: string } };

function mediaParameter(
  kind: 'image' | 'video' | 'document',
  media: { link?: string; id?: string },
): MetaSendParameter {
  return kind === 'image'
    ? { type: 'image', image: media }
    : kind === 'video'
      ? { type: 'video', video: media }
      : { type: 'document', document: media };
}

function buildLocationHeader(location: LocationSendParams | undefined): MetaSendComponent {
  if (!location) throw new Error(t('locationValueRequired'));
  const { latitude, longitude, name, address } = location;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new Error(t('locationValueInvalid'));
  }
  const value: { latitude: number; longitude: number; name?: string; address?: string } = {
    latitude,
    longitude,
  };
  if (name?.trim()) value.name = name;
  if (address?.trim()) value.address = address;
  return { type: 'header', parameters: [{ type: 'location', location: value }] };
}

function buildHeaderComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const headerType = template.header_type;
  if (!headerType) return null;

  if (headerType === 'location') return buildLocationHeader(params.location);

  if (headerType === 'text') {
    // TEXT header with {{1}} → need a value. Static text headers
    // (no variables) just ride along inside the template itself; no
    // header component required on send.
    const varCount = extractVariableIndices(template.header_content ?? '').length;
    if (varCount === 0) return null;
    const value = params.headerText;
    if (!value || !value.trim()) {
      throw new Error(
        t('headerTextValueRequired', { var: '{{1}}' }),
      );
    }
    return {
      type: 'header',
      parameters: [{ type: 'text', text: value }],
    };
  }

  // image / video / document — Meta requires the media component on
  // every send. Prefer the caller's explicit override; fall back to the
  // template's stored public URL.
  //
  // NOTE: `template.header_handle` is intentionally NOT used here. It's a
  // Resumable-Upload handle that's only valid as the *creation-time*
  // sample (`example.header_handle`); it is NOT a reusable send-time
  // media id, and passing it as `{ id }` makes Meta reject the send. Only
  // an explicit `headerMediaId` (a real /media upload id) is honored.
  const link = params.headerMediaUrl ?? template.header_media_url;
  const id = params.headerMediaId;
  if (!link && !id) {
    throw new Error(
      t('mediaHeaderSendSource', { type: headerType }),
    );
  }
  const mediaPayload: { link?: string; id?: string } = id ? { id } : { link };
  return {
    type: 'header',
    parameters: [mediaParameter(headerType, mediaPayload)],
  };
}

function buildBodyComponent(
  template: Pick<MessageTemplate, 'body_text'>,
  params: Pick<SendTimeParams, 'body'>,
): MetaSendComponent | null {
  const varCount = extractVariableIndices(template.body_text).length;
  const body = params.body ?? [];
  if (varCount === 0 && body.length === 0) return null;
  if (body.length < varCount) {
    throw new Error(
      t('bodyValuesMissing', { count: varCount, got: body.length }),
    );
  }
  // Trim to the variable count — extra values are dropped silently so
  // a legacy caller that passes too many doesn't error out.
  const values = body.slice(0, varCount);
  return {
    type: 'body',
    parameters: values.map((text) => ({ type: 'text', text: String(text) })),
  };
}

function buttonNeedsSendParam(
  button: TemplateButton,
  override: string | undefined,
): boolean {
  switch (button.type) {
    case 'URL':
      return extractVariableIndices(button.url).length > 0;
    case 'COPY_CODE':
      // We always emit a button param for COPY_CODE so the customer
      // gets a real code (either the caller's override or the
      // template's example as a default).
      return true;
    case 'QUICK_REPLY':
    case 'PHONE_NUMBER':
    case 'FLOW':
      return override !== undefined;
  }
}

function buildButtonComponent(
  button: TemplateButton,
  index: number,
  override: string | undefined,
): MetaSendButtonComponent | null {
  if (!buttonNeedsSendParam(button, override)) return null;

  switch (button.type) {
    case 'URL': {
      // Each URL button is its own component with sub_type=url and
      // the button's index in the template's buttons array.
      if (!override || !override.trim()) {
        throw new Error(
          t('urlButtonParamRequired', { n: index + 1, var: '{{1}}', index }),
        );
      }
      return {
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: override }],
      };
    }
    case 'COPY_CODE': {
      const code = override?.trim() || button.example;
      return {
        type: 'button',
        sub_type: 'copy_code',
        index: String(index),
        parameters: [{ type: 'coupon_code', coupon_code: code }],
      };
    }
    case 'QUICK_REPLY': {
      // Only included when the caller explicitly overrides the
      // payload (rare — usually QR buttons use their default text).
      return {
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: override! }],
      };
    }
    case 'PHONE_NUMBER':
      // PHONE_NUMBER buttons never accept send-time params per Meta —
      // return null even if an override snuck through.
      return null;
    case 'FLOW':
      // The override is this send's flow token (see SendTimeParams.flowTokens).
      return {
        type: 'button',
        sub_type: 'flow',
        index: String(index),
        parameters: [{ type: 'action', action: { flow_token: override! } }],
      };
  }
}

function buildButtonComponents(
  buttons: TemplateButton[] | undefined,
  params: Pick<SendTimeParams, 'buttonParams' | 'couponCode' | 'flowTokens'>,
): MetaSendComponent[] {
  const out: MetaSendComponent[] = [];
  (buttons ?? []).forEach((btn, i) => {
    // A flow token is only ever generated server-side, never taken from buttonParams.
    const override = btn.type === 'FLOW'
      ? params.flowTokens?.[i]
      : params.buttonParams?.[i] ?? (btn.type === 'COPY_CODE' ? params.couponCode : undefined);
    const component = buildButtonComponent(btn, i, override);
    if (component) out.push(component);
  });
  return out;
}

/**
 * Authentication: the code fills the Meta-written body's {{1}} and the
 * OTP copy-code button (sent as a url sub_type, per Meta's send spec).
 * The stored body_text is a placeholder and is never sent.
 */
function buildAuthenticationComponents(params: SendTimeParams): MetaSendComponent[] {
  const code = params.authCode?.trim();
  if (!code) throw new Error(t('authCodeRequired'));
  if (code.length > AUTH_CODE_MAX_LENGTH) {
    throw new Error(t('authCodeTooLong', { max: AUTH_CODE_MAX_LENGTH }));
  }
  return [
    { type: 'body', parameters: [{ type: 'text', text: code }] },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: code }],
    },
  ];
}

function buildOfferComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  if (!template.lto?.has_expiration) return null;
  const ms = params.offerExpirationTimeMs;
  if (ms == null || !Number.isInteger(ms) || ms <= 0) {
    throw new Error(t('ltoExpirationRequired'));
  }
  return {
    type: 'limited_time_offer',
    parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: ms } }],
  };
}

function buildCard(
  card: CarouselCard,
  cardIndex: number,
  params: CarouselCardSendParams,
): { card_index: number; components: MetaSendComponent[] } {
  const n = cardIndex + 1;
  const link = params.headerMediaUrl ?? card.header_media_url;
  const id = params.headerMediaId;
  if (!link && !id) {
    throw new Error(t('cardMediaSendSource', { n, type: card.header_type }));
  }
  const components: MetaSendComponent[] = [
    { type: 'header', parameters: [mediaParameter(card.header_type, id ? { id } : { link })] },
  ];
  try {
    const body = buildBodyComponent(card, params);
    if (body) components.push(body);
    (card.buttons ?? []).forEach((btn, i) => {
      // Card quick replies always carry a payload; default to the label.
      const override =
        params.buttonParams?.[i] ?? (btn.type === 'QUICK_REPLY' ? btn.text : undefined);
      const component = buildButtonComponent(btn, i, override);
      if (component) components.push(component);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(t('cardError', { n, message }));
  }
  return { card_index: cardIndex, components };
}

function buildCarouselComponents(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent[] {
  const out: MetaSendComponent[] = [];
  const body = buildBodyComponent(template, params);
  if (body) out.push(body);
  out.push({
    type: 'carousel',
    cards: (template.cards ?? []).map((card, i) => buildCard(card, i, params.cards?.[i] ?? {})),
  });
  return out;
}

/**
 * Build the full `components` array for the send-message payload.
 * Returns an empty array when the template is fully static (no
 * variables, no media header), which is a valid Meta request.
 */
export function buildSendComponents(
  template: MessageTemplate,
  params: SendTimeParams = {},
): MetaSendComponent[] {
  const kind = templateKindOf(template);
  if (kind === 'authentication') return buildAuthenticationComponents(params);
  if (kind === 'carousel') return buildCarouselComponents(template, params);

  const out: MetaSendComponent[] = [];
  const header = buildHeaderComponent(template, params);
  if (header) out.push(header);
  if (kind === 'limited_time_offer') {
    const offer = buildOfferComponent(template, params);
    if (offer) out.push(offer);
  }
  const body = buildBodyComponent(template, params);
  if (body) out.push(body);
  out.push(...buildButtonComponents(template.buttons, params));
  return out;
}
