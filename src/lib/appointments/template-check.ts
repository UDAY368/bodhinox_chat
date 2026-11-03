/**
 * Whether a template can carry an appointment message (design D5, D15).
 * Pure, no server-only imports: the settings form, the settings route and the
 * dispatch jobs all call it. Returns a stable code (translated in the UI as
 * AppointmentSettings.templateErrors.<code>) or null.
 *
 * Allowed: an approved UTILITY template with body variables, an optional TEXT
 * header variable, a static media header with a stored URL, and at most one
 * URL button whose variable suffix is the manage token, i.e. a URL of exactly
 * `${APP_URL}/my-booking/{{1}}`. Quick-reply, phone and static URL buttons are
 * harmless and allowed.
 */
import type { MessageTemplate } from '@/types';
import { extractVariableIndices, templateKindOf } from '@/lib/whatsapp/template-validators';

export const APPOINTMENT_TEMPLATE_REFUSALS = [
  'not_utility', 'authentication', 'carousel', 'limited_time_offer', 'location_header',
  'media_header_without_url', 'header_variables', 'flow_button', 'too_many_url_buttons', 'url_button_base',
] as const;
export type AppointmentTemplateRefusal = (typeof APPOINTMENT_TEMPLATE_REFUSALS)[number];

export type AppointmentCheckedTemplate = Pick<
  MessageTemplate,
  'category' | 'body_text' | 'header_type' | 'header_content' | 'header_media_url' | 'buttons' | 'template_kind' | 'cards' | 'lto'
>;

/** The only URL a variable URL button may have: the manage page plus the token. */
export function manageButtonUrl(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/my-booking/{{1}}`;
}

export function appointmentTemplateRefusal(
  template: AppointmentCheckedTemplate | null | undefined,
  appOrigin: string,
): AppointmentTemplateRefusal | null {
  if (!template) return null;
  if (String(template.category ?? '').toLowerCase() !== 'utility') return 'not_utility';
  const kind = templateKindOf(template);
  if (kind === 'authentication') return 'authentication';
  if (kind === 'carousel') return 'carousel';
  if (kind === 'limited_time_offer') return 'limited_time_offer';
  if (template.header_type === 'location') return 'location_header';
  if (
    (template.header_type === 'image' || template.header_type === 'video' || template.header_type === 'document') &&
    !template.header_media_url
  ) return 'media_header_without_url';
  if (template.header_type === 'text' && extractVariableIndices(template.header_content ?? '').length > 1) {
    return 'header_variables';
  }
  const buttons = template.buttons ?? [];
  if (buttons.some((b) => b.type === 'FLOW')) return 'flow_button';
  const variableUrls = buttons.filter((b) => b.type === 'URL' && extractVariableIndices(b.url).length > 0);
  if (variableUrls.length > 1) return 'too_many_url_buttons';
  const expected = manageButtonUrl(appOrigin);
  if (variableUrls.some((b) => b.type === 'URL' && b.url !== expected)) return 'url_button_base';
  return null;
}

/** Index of the manage-link URL button, or null when the template has none. */
export function manageButtonIndex(template: Pick<MessageTemplate, 'buttons'>): number | null {
  const index = (template.buttons ?? []).findIndex((b) => b.type === 'URL' && extractVariableIndices(b.url).length > 0);
  return index >= 0 ? index : null;
}
