/**
 * Send-time values for every template kind, shared by the places that
 * send templates: the inbox picker and send route, campaigns (wizard,
 * creation, worker), flows and automations.
 *
 *   - `templateSendNeeds` says which values a template asks for, so a
 *     picker shows exactly those inputs.
 *   - `templateSendRefusal` keeps authentication templates to the inbox
 *     and the API: a one-time code is typed for one person, so bulk and
 *     automatic senders never carry one.
 *   - `parseSendTimeParams` checks untrusted JSON (browser, public API)
 *     before it reaches `buildSendComponents`.
 *   - Campaigns freeze carousel card variables after the top body values
 *     in each recipient's one `template_params` array: `campaignVariableKeys`
 *     names the slots and `splitFrozenParams` cuts them back apart.
 *
 * No server-only imports: the inbox picker and campaign wizard use this too.
 */

import type { MessageTemplate, TemplateKind } from '@/types';
import { getT } from '@/lib/i18n/translate';
import { extractVariableIndices, templateKindOf } from './template-validators';
import {
  AUTH_CODE_MAX_LENGTH,
  type CarouselCardSendParams,
  type LocationSendParams,
  type SendTimeParams,
} from './template-send-builder';

const t = getT('Validation.templateSend');

/** Longest code Meta shows on a copy-code button. */
export const COUPON_CODE_MAX_LENGTH = 15;
/** Longest single send-time value we pass on (Meta's body limit). */
export const SEND_VALUE_MAX_LENGTH = 1024;
const LOCATION_TEXT_MAX_LENGTH = 1000;
const MAX_VALUES = 50;
const MAX_CARDS = 10;

export type TemplateSendSurface = 'inbox' | 'api' | 'campaign' | 'automation' | 'flow';

/** Surfaces where a person (or an API caller) supplies the one-time code. */
const AUTH_SURFACES: ReadonlySet<TemplateSendSurface> = new Set(['inbox', 'api']);

/**
 * Why `template` cannot be sent from `surface`, or null when it can.
 * Today only authentication templates are restricted.
 */
export function templateSendRefusal(
  template: { template_kind?: TemplateKind | null } | null | undefined,
  surface: TemplateSendSurface,
): string | null {
  if (!template) return null;
  if (templateKindOf(template) === 'authentication' && !AUTH_SURFACES.has(surface)) {
    return t('authOnlyInbox');
  }
  return null;
}

/** Thrown by `assertTemplateSendable`; `code` is stable for callers and tests. */
export class TemplateSendRefusedError extends Error {
  readonly code = 'template_kind_not_allowed';
  constructor(message: string) {
    super(message);
    this.name = 'TemplateSendRefusedError';
  }
}

export function assertTemplateSendable(
  template: { template_kind?: TemplateKind | null } | null | undefined,
  surface: TemplateSendSurface,
): void {
  const refusal = templateSendRefusal(template, surface);
  if (refusal) throw new TemplateSendRefusedError(refusal);
}

// ------------------------------------------------------------
// What a template asks for
// ------------------------------------------------------------

export interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

export interface TemplateSendNeeds {
  kind: TemplateKind;
  /** Top-level body {{n}} indices (none for authentication). */
  bodyVars: number[];
  headerVarCount: number;
  urlButtons: UrlButtonSlot[];
  /** Copy-code buttons; the stored example is the default code. */
  couponButtons: { index: number; text: string; example: string }[];
  location: boolean;
  offerExpiration: boolean;
  authCode: boolean;
  cards: { index: number; bodyVars: number[]; urlButtons: UrlButtonSlot[] }[];
}

type NeedsTemplate = Pick<
  MessageTemplate,
  'body_text' | 'header_type' | 'header_content' | 'buttons' | 'template_kind' | 'cards' | 'lto'
>;

function urlButtonSlots(buttons: MessageTemplate['buttons']): UrlButtonSlot[] {
  const out: UrlButtonSlot[] = [];
  (buttons ?? []).forEach((b, index) => {
    if (b.type === 'URL' && extractVariableIndices(b.url).length > 0) {
      out.push({ index, text: b.text, url: b.url });
    }
  });
  return out;
}

export function templateSendNeeds(template: NeedsTemplate): TemplateSendNeeds {
  const kind = templateKindOf(template);
  if (kind === 'authentication') {
    return {
      kind, bodyVars: [], headerVarCount: 0, urlButtons: [], couponButtons: [],
      location: false, offerExpiration: false, authCode: true, cards: [],
    };
  }
  const couponButtons: TemplateSendNeeds['couponButtons'] = [];
  (template.buttons ?? []).forEach((b, index) => {
    if (b.type === 'COPY_CODE') couponButtons.push({ index, text: b.text, example: b.example });
  });
  return {
    kind,
    bodyVars: extractVariableIndices(template.body_text ?? ''),
    headerVarCount:
      template.header_type === 'text' && template.header_content
        ? extractVariableIndices(template.header_content).length
        : 0,
    urlButtons: kind === 'carousel' ? [] : urlButtonSlots(template.buttons),
    couponButtons: kind === 'carousel' ? [] : couponButtons,
    location: kind !== 'carousel' && template.header_type === 'location',
    offerExpiration: kind === 'limited_time_offer' && !!template.lto?.has_expiration,
    authCode: false,
    cards:
      kind === 'carousel'
        ? (template.cards ?? []).map((card, index) => ({
            index,
            bodyVars: extractVariableIndices(card.body_text ?? ''),
            urlButtons: urlButtonSlots(card.buttons),
          }))
        : [],
  };
}

// ------------------------------------------------------------
// Campaign slots: top body values, then each card's body values
// ------------------------------------------------------------

/** Variable key for card `cardIndex` (0-based) body {{n}}: "c1_2" is card 1, {{2}}. */
export function cardVariableKey(cardIndex: number, n: number): string {
  return `c${cardIndex + 1}_${n}`;
}

/** Matches a top-level key ("1".."99") or a card key ("c1_1".."c10_99"). */
export const CAMPAIGN_VARIABLE_KEY = /^(?:[1-9]\d?|c(?:10|[1-9])_[1-9]\d?)$/;

/** Every variable a campaign maps, in the order values are frozen. */
export function campaignVariableKeys(template: NeedsTemplate): string[] {
  const needs = templateSendNeeds(template);
  return [
    ...needs.bodyVars.map(String),
    ...needs.cards.flatMap((card) => card.bodyVars.map((n) => cardVariableKey(card.index, n))),
  ];
}

/** Cut a recipient's frozen values back into body and per-card values. */
export function splitFrozenParams(
  template: NeedsTemplate,
  flat: string[],
): Pick<SendTimeParams, 'body' | 'cards'> {
  const needs = templateSendNeeds(template);
  if (needs.kind !== 'carousel') return { body: flat };
  let at = needs.bodyVars.length;
  const cards: CarouselCardSendParams[] = needs.cards.map((card) => {
    const body = flat.slice(at, at + card.bodyVars.length);
    at += card.bodyVars.length;
    return body.length ? { body } : {};
  });
  return { body: flat.slice(0, needs.bodyVars.length), cards };
}

// ------------------------------------------------------------
// Parsing untrusted send-time JSON
// ------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

class ParamError extends Error {}
const fail = (key: string, values?: Record<string, string | number>): never => {
  throw new ParamError(t(key, values));
};

function value(v: unknown, field: string): string {
  // Numbers were always accepted (sent as their text) — keep that for API callers.
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') fail('valueNotText', { field });
  if ((v as string).length > SEND_VALUE_MAX_LENGTH) fail('valueTooLong', { field, max: SEND_VALUE_MAX_LENGTH });
  return v as string;
}

function values(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) return fail('valueNotList', { field });
  if (v.length > MAX_VALUES) fail('tooManyValues', { field, max: MAX_VALUES });
  return v.map((x, i) => value(x, `${field}[${i + 1}]`));
}

function buttonValues(v: unknown, field: string): Record<number, string> {
  if (!isRecord(v)) return fail('valueNotObject', { field });
  const out: Record<number, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!/^\d{1,2}$/.test(k)) fail('buttonIndexInvalid', { field });
    if (x == null) continue;
    out[Number(k)] = value(x, `${field}[${k}]`);
  }
  return out;
}

function optionalText(v: unknown, field: string, max: number): string | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') return fail('valueNotText', { field });
  if (v.length > max) fail('valueTooLong', { field, max });
  return v;
}

/** Latitude/longitude as numbers or numeric strings; name and address optional. */
export function parseLocation(v: unknown): ParseResult<LocationSendParams> {
  try {
    return { ok: true, value: location(v) };
  } catch (err) {
    if (err instanceof ParamError) return { ok: false, error: err.message };
    throw err;
  }
}

function coordinate(v: unknown, limit: number): number {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > limit) fail('locationInvalid');
  return n as number;
}

function location(v: unknown): LocationSendParams {
  if (!isRecord(v)) return fail('locationInvalid');
  const out: LocationSendParams = {
    latitude: coordinate(v.latitude, 90),
    longitude: coordinate(v.longitude, 180),
  };
  const name = optionalText(v.name, 'location.name', LOCATION_TEXT_MAX_LENGTH);
  const address = optionalText(v.address, 'location.address', LOCATION_TEXT_MAX_LENGTH);
  if (name?.trim()) out.name = name.trim();
  if (address?.trim()) out.address = address.trim();
  return out;
}

/** A copy-code value: 1-15 characters, no surrounding spaces. */
export function parseCouponCode(v: unknown): ParseResult<string | undefined> {
  if (v == null || (typeof v === 'string' && !v.trim())) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, error: t('valueNotText', { field: 'couponCode' }) };
  const code = v.trim();
  if (code.length > COUPON_CODE_MAX_LENGTH) {
    return { ok: false, error: t('couponTooLong', { max: COUPON_CODE_MAX_LENGTH }) };
  }
  return { ok: true, value: code };
}

/** An offer end time: whole epoch milliseconds, after `now`. */
export function parseOfferExpiration(v: unknown, now = Date.now()): ParseResult<number | undefined> {
  if (v == null) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    return { ok: false, error: t('offerExpirationInvalid') };
  }
  if (v <= now) return { ok: false, error: t('offerExpirationPast') };
  return { ok: true, value: v };
}

function unwrap<T>(r: ParseResult<T>): T {
  if (!r.ok) throw new ParamError(r.error);
  return r.value;
}

function card(v: unknown, i: number): CarouselCardSendParams {
  const field = `cards[${i + 1}]`;
  if (v == null) return {};
  if (!isRecord(v)) return fail('valueNotObject', { field });
  const out: CarouselCardSendParams = {};
  if (v.body != null) out.body = values(v.body, `${field}.body`);
  if (v.buttonParams != null) out.buttonParams = buttonValues(v.buttonParams, `${field}.buttonParams`);
  const url = optionalText(v.headerMediaUrl, `${field}.headerMediaUrl`, 2048);
  const id = optionalText(v.headerMediaId, `${field}.headerMediaId`, 256);
  if (url) out.headerMediaUrl = url;
  if (id) out.headerMediaId = id;
  return out;
}

/**
 * Validate structured send-time values from an untrusted caller. Unknown
 * keys are dropped (the public API never rejected them); null or absent
 * input means "no structured values".
 */
export function parseSendTimeParams(
  raw: unknown,
  now = Date.now(),
): ParseResult<SendTimeParams | undefined> {
  if (raw == null) return { ok: true, value: undefined };
  try {
    if (!isRecord(raw)) fail('valueNotObject', { field: 'template_message_params' });
    const r = raw as Record<string, unknown>;
    const out: SendTimeParams = {};
    if (r.body != null) out.body = values(r.body, 'body');
    const headerText = optionalText(r.headerText, 'headerText', SEND_VALUE_MAX_LENGTH);
    if (headerText !== undefined) out.headerText = headerText;
    const mediaUrl = optionalText(r.headerMediaUrl, 'headerMediaUrl', 2048);
    if (mediaUrl) out.headerMediaUrl = mediaUrl;
    const mediaId = optionalText(r.headerMediaId, 'headerMediaId', 256);
    if (mediaId) out.headerMediaId = mediaId;
    if (r.buttonParams != null) out.buttonParams = buttonValues(r.buttonParams, 'buttonParams');
    if (r.location != null) out.location = location(r.location);
    if (r.authCode != null) {
      if (typeof r.authCode !== 'string' || !r.authCode.trim()) fail('authCodeInvalid');
      const code = (r.authCode as string).trim();
      if (code.length > AUTH_CODE_MAX_LENGTH) fail('authCodeTooLong', { max: AUTH_CODE_MAX_LENGTH });
      out.authCode = code;
    }
    const offer = unwrap(parseOfferExpiration(r.offerExpirationTimeMs, now));
    if (offer !== undefined) out.offerExpirationTimeMs = offer;
    const coupon = unwrap(parseCouponCode(r.couponCode));
    if (coupon !== undefined) out.couponCode = coupon;
    if (r.cards != null) {
      if (!Array.isArray(r.cards)) fail('valueNotList', { field: 'cards' });
      const list = r.cards as unknown[];
      if (list.length > MAX_CARDS) fail('tooManyValues', { field: 'cards', max: MAX_CARDS });
      out.cards = list.map(card);
    }
    return { ok: true, value: out };
  } catch (err) {
    if (err instanceof ParamError) return { ok: false, error: err.message };
    throw err;
  }
}

// ------------------------------------------------------------
// Values a campaign fixes for every recipient
// ------------------------------------------------------------

/**
 * Key under `broadcasts.template_variables` that holds a campaign's
 * extras, beside the variable mappings ("1", "c1_2", …), so every pass
 * (first send, schedule, resume, retry) reads the same values.
 */
export const CAMPAIGN_SEND_EXTRAS_KEY = '_send';

/** Same for every recipient of a campaign. */
export interface CampaignSendExtras {
  location?: LocationSendParams;
  offerExpirationTimeMs?: number;
  couponCode?: string;
}

/** Validate campaign extras; `notBefore` is when sending starts (now or the schedule). */
export function parseCampaignSendExtras(
  raw: unknown,
  notBefore = Date.now(),
): ParseResult<CampaignSendExtras> {
  if (raw == null) return { ok: true, value: {} };
  try {
    if (!isRecord(raw)) fail('valueNotObject', { field: 'sendExtras' });
    const r = raw as Record<string, unknown>;
    const out: CampaignSendExtras = {};
    if (r.location != null) out.location = location(r.location);
    const offer = unwrap(parseOfferExpiration(r.offerExpirationTimeMs, notBefore));
    if (offer !== undefined) out.offerExpirationTimeMs = offer;
    const coupon = unwrap(parseCouponCode(r.couponCode));
    if (coupon !== undefined) out.couponCode = coupon;
    return { ok: true, value: out };
  } catch (err) {
    if (err instanceof ParamError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Extras read back from a stored job payload: only well-formed fields survive. */
export function storedCampaignSendExtras(raw: unknown): CampaignSendExtras {
  if (!isRecord(raw)) return {};
  const out: CampaignSendExtras = {};
  const loc = parseLocation(raw.location);
  if (raw.location != null && loc.ok) out.location = loc.value;
  // No "in the future" check here: a paused campaign resumes with the
  // expiry it was created with and Meta decides.
  const ms = raw.offerExpirationTimeMs;
  if (typeof ms === 'number' && Number.isInteger(ms) && ms > 0) out.offerExpirationTimeMs = ms;
  const coupon = parseCouponCode(raw.couponCode);
  if (coupon.ok && coupon.value) out.couponCode = coupon.value;
  return out;
}

// ------------------------------------------------------------
// Flow send_template extras
// ------------------------------------------------------------

/** Longest relative offer window a flow step may set (90 days). */
export const FLOW_OFFER_MAX_MINUTES = 90 * 24 * 60;

export interface FlowTemplateExtras {
  location?: { latitude?: unknown; longitude?: unknown; name?: unknown; address?: unknown };
  offer_expires_in_minutes?: unknown;
  coupon_code?: unknown;
  card_params?: unknown;
}

/** Saved-config problems for a flow's send_template extras, as field + message. */
export function flowTemplateExtrasIssues(cfg: FlowTemplateExtras): { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = [];
  if (cfg.location != null) {
    const r = parseLocation(cfg.location);
    if (!r.ok) issues.push({ field: 'location', message: r.error });
  }
  const minutes = cfg.offer_expires_in_minutes;
  if (
    minutes != null &&
    (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > FLOW_OFFER_MAX_MINUTES)
  ) {
    issues.push({ field: 'offer_expires_in_minutes', message: t('flowOfferMinutes', { max: FLOW_OFFER_MAX_MINUTES }) });
  }
  if (cfg.coupon_code != null) {
    // Placeholders such as {{vars.code}} resolve at send time; only the shape is checked here.
    if (typeof cfg.coupon_code !== 'string') {
      issues.push({ field: 'coupon_code', message: t('valueNotText', { field: 'coupon_code' }) });
    }
  }
  if (cfg.card_params != null) {
    const cards = cfg.card_params;
    if (!Array.isArray(cards) || cards.length > MAX_CARDS) {
      issues.push({ field: 'card_params', message: t('valueNotList', { field: 'card_params' }) });
    } else {
      cards.forEach((list, c) => {
        if (!Array.isArray(list)) {
          issues.push({ field: `card_params.${c}`, message: t('valueNotList', { field: `card_params.${c + 1}` }) });
          return;
        }
        list.forEach((v, i) => {
          if (typeof v !== 'string' || !v.trim()) {
            issues.push({ field: `card_params.${c}.${i}`, message: t('cardValueEmpty', { card: c + 1, n: i + 1 }) });
          }
        });
      });
    }
  }
  return issues;
}

/**
 * Send-time values a flow step adds beyond body and quick replies.
 * `fill` interpolates run variables; empty results become "-" as for
 * body values (Meta rejects empty parameters).
 */
export function flowTemplateSendExtras(
  cfg: FlowTemplateExtras,
  fill: (s: string) => string,
  now = Date.now(),
): Pick<SendTimeParams, 'location' | 'offerExpirationTimeMs' | 'couponCode' | 'cards'> {
  const out: Pick<SendTimeParams, 'location' | 'offerExpirationTimeMs' | 'couponCode' | 'cards'> = {};
  if (cfg.location != null) {
    const loc = parseLocation(cfg.location);
    if (loc.ok) out.location = loc.value;
  }
  const minutes = cfg.offer_expires_in_minutes;
  if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0) {
    out.offerExpirationTimeMs = now + Math.min(minutes, FLOW_OFFER_MAX_MINUTES) * 60_000;
  }
  if (typeof cfg.coupon_code === 'string' && cfg.coupon_code.trim()) {
    const code = fill(cfg.coupon_code).trim();
    if (code) out.couponCode = code.slice(0, COUPON_CODE_MAX_LENGTH);
  }
  if (Array.isArray(cfg.card_params)) {
    out.cards = cfg.card_params.map((list) =>
      Array.isArray(list)
        ? { body: list.map((v) => (typeof v === 'string' ? fill(v).trim() || '-' : '-')) }
        : {},
    );
  }
  return out;
}
