/**
 * Premade WhatsApp message template library.
 *
 * Ready-to-submit Marketing and Utility templates, grouped by industry,
 * that users can copy into the template editor and send to Meta for
 * review. Like the starter flows (src/lib/flows/templates.ts) this is a
 * static module: the set changes with code releases, not data.
 *
 * Wording lives in the message catalogue under `TemplateLibrary.<slug>`
 * so every build locale gets natural copy. Body messages write WhatsApp
 * variables as ICU params `{v1}`, `{v2}`, ... which are filled with the
 * literal `{{1}}`, `{{2}}`, ... here; translators may reorder them but
 * each locale must keep the full contiguous set. Sample values are one
 * `|`-separated message, in variable order.
 *
 * URL and phone buttons carry placeholders (https://example.com,
 * +10000000000) the user replaces before submitting: a draft may keep
 * them, but validateTemplatePayload refuses them at submit time.
 */

import type { TemplateButton } from '@/types';
import { getT } from '@/lib/i18n/translate';
import type { TemplatePayload } from './template-validators';

export const TEMPLATE_LIBRARY_INDUSTRIES = [
  'retail',
  'food',
  'health',
  'beauty',
  'education',
  'real_estate',
  'travel',
  'finance',
  'events',
  'services',
  'general',
] as const;

export type TemplateLibraryIndustry = (typeof TEMPLATE_LIBRARY_INDUSTRIES)[number];
export type TemplateLibraryCategory = 'Marketing' | 'Utility';

export const LIBRARY_URL_PLACEHOLDER = 'https://example.com';
export const LIBRARY_PHONE_PLACEHOLDER = '+10000000000';

export interface LibraryTemplate {
  slug: string;
  industry: TemplateLibraryIndustry;
  category: TemplateLibraryCategory;
  /** Gallery card title and one-line description (not sent to Meta). */
  title: string;
  description: string;
  /** Valid Meta template name (lowercase, digits, underscore). */
  name: string;
  header?: { type: 'text'; text: string };
  body_text: string;
  footer_text?: string;
  buttons?: TemplateButton[];
  sample_values: { body: string[] };
}

type ButtonKind = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';

interface Spec {
  slug: string;
  industry: TemplateLibraryIndustry;
  category: TemplateLibraryCategory;
  header?: true;
  footer?: true;
  /** One entry per button; text comes from `buttons.b1`, `b2`, ... */
  buttons?: ButtonKind[];
}

const SPECS: Spec[] = [
  // retail / e-commerce
  { slug: 'order_confirmation', industry: 'retail', category: 'Utility', header: true, footer: true, buttons: ['URL'] },
  { slug: 'shipping_update', industry: 'retail', category: 'Utility', header: true, buttons: ['URL'] },
  { slug: 'delivery_delayed', industry: 'retail', category: 'Utility', buttons: ['QUICK_REPLY'] },
  { slug: 'back_in_stock', industry: 'retail', category: 'Marketing', buttons: ['URL'] },
  { slug: 'festive_offer', industry: 'retail', category: 'Marketing', header: true, footer: true, buttons: ['QUICK_REPLY', 'URL'] },
  { slug: 'abandoned_cart', industry: 'retail', category: 'Marketing', buttons: ['URL'] },
  { slug: 'price_drop', industry: 'retail', category: 'Marketing', buttons: ['URL'] },
  { slug: 'loyalty_points', industry: 'retail', category: 'Marketing', buttons: ['URL'] },
  // food
  { slug: 'table_reservation', industry: 'food', category: 'Utility', header: true, buttons: ['QUICK_REPLY', 'QUICK_REPLY'] },
  { slug: 'order_ready_pickup', industry: 'food', category: 'Utility', buttons: ['PHONE_NUMBER'] },
  // health / beauty
  { slug: 'appointment_reminder', industry: 'health', category: 'Utility', header: true, buttons: ['QUICK_REPLY', 'QUICK_REPLY'] },
  { slug: 'appointment_confirmed', industry: 'beauty', category: 'Utility', buttons: ['PHONE_NUMBER'] },
  // Phase 7 appointment reminders: the URL button must become `${APP_URL}/my-booking/{{1}}`
  // (src/lib/appointments/template-check.ts manageButtonUrl); the job fills {{1}} with the manage token.
  { slug: 'appointment_reminder_manage', industry: 'health', category: 'Utility', header: true, buttons: ['URL'] },
  // finance
  { slug: 'payment_reminder', industry: 'finance', category: 'Utility', buttons: ['URL'] },
  { slug: 'payment_received', industry: 'finance', category: 'Utility', header: true, footer: true },
  { slug: 'emi_due', industry: 'finance', category: 'Utility', buttons: ['URL'] },
  { slug: 'document_request', industry: 'finance', category: 'Utility', buttons: ['QUICK_REPLY'] },
  { slug: 'account_update', industry: 'finance', category: 'Utility', buttons: ['PHONE_NUMBER'] },
  // education
  { slug: 'class_reminder', industry: 'education', category: 'Utility', buttons: ['URL'] },
  { slug: 'admission_open', industry: 'education', category: 'Marketing', header: true, footer: true, buttons: ['URL'] },
  // real estate
  { slug: 'site_visit_confirmed', industry: 'real_estate', category: 'Utility', buttons: ['PHONE_NUMBER'] },
  // travel
  { slug: 'booking_confirmed', industry: 'travel', category: 'Utility', header: true, buttons: ['URL'] },
  { slug: 'check_in_details', industry: 'travel', category: 'Utility', buttons: ['PHONE_NUMBER'] },
  // events
  { slug: 'event_reminder', industry: 'events', category: 'Utility', buttons: ['URL'] },
  { slug: 'webinar_link', industry: 'events', category: 'Utility', buttons: ['URL'] },
  // services
  { slug: 'renewal_reminder', industry: 'services', category: 'Utility', buttons: ['URL'] },
  { slug: 'service_follow_up', industry: 'services', category: 'Utility', buttons: ['QUICK_REPLY', 'QUICK_REPLY'] },
  // general
  { slug: 'welcome_message', industry: 'general', category: 'Marketing', header: true, buttons: ['QUICK_REPLY', 'QUICK_REPLY'] },
  { slug: 'feedback_request', industry: 'general', category: 'Marketing', buttons: ['QUICK_REPLY', 'QUICK_REPLY', 'QUICK_REPLY'] },
  { slug: 'store_opening_hours', industry: 'general', category: 'Marketing', buttons: ['PHONE_NUMBER'] },
  { slug: 'holiday_notice', industry: 'general', category: 'Marketing', header: true },
];

/** ICU params that turn `{v1}`..`{v9}` into WhatsApp's literal `{{1}}`..`{{9}}`. */
const VARIABLES: Record<string, string> = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [`v${i + 1}`, `{{${i + 1}}}`]),
);

function button(kind: ButtonKind, text: string): TemplateButton {
  switch (kind) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text };
    case 'URL':
      return { type: 'URL', text, url: LIBRARY_URL_PLACEHOLDER };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text, phone_number: LIBRARY_PHONE_PLACEHOLDER };
  }
}

function build(spec: Spec): LibraryTemplate {
  const t = getT(`TemplateLibrary.${spec.slug}`);
  const body = t('body', VARIABLES);
  const samples = t('samples').split('|').map((s) => s.trim());
  return {
    slug: spec.slug,
    industry: spec.industry,
    category: spec.category,
    title: t('title'),
    description: t('description'),
    name: spec.slug,
    ...(spec.header ? { header: { type: 'text' as const, text: t('header') } } : {}),
    body_text: body,
    ...(spec.footer ? { footer_text: t('footer') } : {}),
    ...(spec.buttons ? { buttons: spec.buttons.map((kind, i) => button(kind, t(`buttons.b${i + 1}`))) } : {}),
    sample_values: { body: samples },
  };
}

let cache: LibraryTemplate[] | null = null;

export function listLibraryTemplates(): LibraryTemplate[] {
  cache ??= SPECS.map(build);
  return cache;
}

export function getLibraryTemplate(slug: string): LibraryTemplate | undefined {
  return listLibraryTemplates().find((tpl) => tpl.slug === slug);
}

/** Localised industry label, for gallery filters. */
export function libraryIndustryLabel(industry: TemplateLibraryIndustry): string {
  return getT('TemplateLibrary.industries')(industry);
}

/** The library entry as the payload the template editor / validator takes. */
export function libraryTemplatePayload(tpl: LibraryTemplate, language: string): TemplatePayload {
  return {
    name: tpl.name,
    category: tpl.category,
    language,
    ...(tpl.header ? { header_type: 'text' as const, header_content: tpl.header.text } : {}),
    body_text: tpl.body_text,
    ...(tpl.footer_text ? { footer_text: tpl.footer_text } : {}),
    ...(tpl.buttons ? { buttons: tpl.buttons } : {}),
    sample_values: { body: tpl.sample_values.body },
  };
}
