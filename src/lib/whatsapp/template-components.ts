/**
 * Translate our local template row shape into the `components` array
 * shape that Meta's POST /{waba_id}/message_templates endpoint expects.
 *
 * Keep this function pure and JSON-shaped — the submit route and the
 * (future) edit route both call it, and unit tests assert the exact
 * payload by snapshot.
 *
 * Spec reference:
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components
 */

import { templateKindOf, type TemplatePayload } from './template-validators';
import type { CarouselCard, TemplateButton } from '@/types';

export interface MetaComponent {
  type:
    | 'HEADER'
    | 'BODY'
    | 'FOOTER'
    | 'BUTTONS'
    | 'CAROUSEL'
    | 'LIMITED_TIME_OFFER';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
  text?: string;
  buttons?: MetaButtonPayload[];
  example?: {
    header_text?: string[];
    header_url?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
  /** CAROUSEL only: each card is its own HEADER/BODY/BUTTONS set. */
  cards?: { components: MetaComponent[] }[];
  /** Authentication BODY only. */
  add_security_recommendation?: boolean;
  /** Authentication FOOTER only. */
  code_expiration_minutes?: number;
  limited_time_offer?: { text: string; has_expiration: boolean };
}

interface MetaButtonPayload {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE' | 'OTP';
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string[];
  otp_type?: 'COPY_CODE';
}

/** IMAGE/VIDEO/DOCUMENT header with its creation-time sample. */
function mediaHeader(
  header_type: 'image' | 'video' | 'document',
  header_handle: string | undefined,
  header_media_url: string | undefined,
): MetaComponent {
  const format =
    header_type === 'image'
      ? 'IMAGE'
      : header_type === 'video'
        ? 'VIDEO'
        : 'DOCUMENT';
  const component: MetaComponent = { type: 'HEADER', format };
  if (header_handle) {
    component.example = { header_handle: [header_handle] };
  } else if (header_media_url) {
    component.example = { header_url: [header_media_url] };
  }
  return component;
}

function buildHeaderComponent(payload: TemplatePayload): MetaComponent | null {
  const { header_type, header_content, header_media_url, header_handle } = payload;
  if (!header_type) return null;

  if (header_type === 'location') {
    return { type: 'HEADER', format: 'LOCATION' };
  }

  if (header_type === 'text') {
    const headerSample = payload.sample_values?.header;
    const component: MetaComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: header_content,
    };
    if (headerSample && headerSample.length > 0) {
      component.example = { header_text: headerSample };
    }
    return component;
  }

  return mediaHeader(header_type, header_handle, header_media_url);
}

function buildBodyComponent(
  payload: Pick<TemplatePayload, 'body_text'> & { sample_values?: { body?: string[] } },
): MetaComponent {
  const component: MetaComponent = {
    type: 'BODY',
    text: payload.body_text,
  };
  const bodySample = payload.sample_values?.body;
  if (bodySample && bodySample.length > 0) {
    // Meta expects body_text as a 2D array — outer is "examples",
    // inner is the values for each variable. We submit a single
    // example row.
    component.example = { body_text: [bodySample] };
  }
  return component;
}

function buildFooterComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.footer_text?.trim()) return null;
  return { type: 'FOOTER', text: payload.footer_text };
}

function buildButtonPayload(b: TemplateButton): MetaButtonPayload {
  switch (b.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: b.text };
    case 'URL': {
      const payload: MetaButtonPayload = {
        type: 'URL',
        text: b.text,
        url: b.url,
      };
      if (b.example) payload.example = [b.example];
      return payload;
    }
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: b.text, example: [b.example] };
  }
}

function buildButtonsComponent(
  payload: Pick<TemplatePayload, 'buttons'>,
): MetaComponent | null {
  if (!payload.buttons || payload.buttons.length === 0) return null;
  return {
    type: 'BUTTONS',
    buttons: payload.buttons.map(buildButtonPayload),
  };
}

function buildCardComponents(card: CarouselCard): { components: MetaComponent[] } {
  const components = [
    mediaHeader(card.header_type, card.header_handle, card.header_media_url),
    buildBodyComponent(card),
  ];
  const buttons = buildButtonsComponent(card);
  if (buttons) components.push(buttons);
  return { components };
}

/** Top-level BODY followed by the CAROUSEL; no header, footer or buttons. */
function buildCarouselComponents(payload: TemplatePayload): MetaComponent[] {
  return [
    buildBodyComponent(payload),
    { type: 'CAROUSEL', cards: (payload.cards ?? []).map(buildCardComponents) },
  ];
}

/**
 * Meta supplies the authentication body text itself, so only the
 * options are sent: the security line, the expiry footer and the one
 * copy-code OTP button (Meta's default label when no text is set).
 */
function buildAuthenticationComponents(payload: TemplatePayload): MetaComponent[] {
  const options = payload.auth_options;
  const body: MetaComponent = { type: 'BODY' };
  if (options?.add_security_recommendation != null) {
    body.add_security_recommendation = options.add_security_recommendation;
  }
  const components: MetaComponent[] = [body];
  if (options?.code_expiration_minutes != null) {
    components.push({
      type: 'FOOTER',
      code_expiration_minutes: options.code_expiration_minutes,
    });
  }
  const otp: MetaButtonPayload = { type: 'OTP', otp_type: 'COPY_CODE' };
  if (options?.button_text?.trim()) otp.text = options.button_text;
  components.push({ type: 'BUTTONS', buttons: [otp] });
  return components;
}

/** HEADER (optional) → LIMITED_TIME_OFFER → BODY → BUTTONS. */
function buildLimitedTimeOfferComponents(payload: TemplatePayload): MetaComponent[] {
  const components: MetaComponent[] = [];
  const header = buildHeaderComponent(payload);
  if (header) components.push(header);
  components.push({
    type: 'LIMITED_TIME_OFFER',
    limited_time_offer: {
      text: payload.lto?.text ?? '',
      has_expiration: payload.lto?.has_expiration === true,
    },
  });
  components.push(buildBodyComponent(payload));
  const buttons = buildButtonsComponent(payload);
  if (buttons) components.push(buttons);
  return components;
}

function buildStandardComponents(payload: TemplatePayload): MetaComponent[] {
  const components: MetaComponent[] = [];
  const header = buildHeaderComponent(payload);
  if (header) components.push(header);
  components.push(buildBodyComponent(payload));
  const footer = buildFooterComponent(payload);
  if (footer) components.push(footer);
  const buttons = buildButtonsComponent(payload);
  if (buttons) components.push(buttons);
  return components;
}

export interface MetaTemplateSubmitPayload {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  components: MetaComponent[];
}

const CATEGORY_TO_META: Record<
  'Marketing' | 'Utility' | 'Authentication',
  MetaTemplateSubmitPayload['category']
> = {
  Marketing: 'MARKETING',
  Utility: 'UTILITY',
  Authentication: 'AUTHENTICATION',
};

/**
 * Assemble the full submit payload (name + category + language +
 * components). Standard templates use the canonical order HEADER →
 * BODY → FOOTER → BUTTONS; the other kinds use the shapes above.
 * Callers validate first (validateTemplatePayload).
 */
export function buildMetaTemplatePayload(
  payload: TemplatePayload,
): MetaTemplateSubmitPayload {
  const kind = templateKindOf(payload);
  const components =
    kind === 'carousel'
      ? buildCarouselComponents(payload)
      : kind === 'authentication'
        ? buildAuthenticationComponents(payload)
        : kind === 'limited_time_offer'
          ? buildLimitedTimeOfferComponents(payload)
          : buildStandardComponents(payload);

  return {
    name: payload.name,
    category: CATEGORY_TO_META[payload.category],
    language: payload.language,
    components,
  };
}
