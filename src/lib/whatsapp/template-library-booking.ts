/**
 * Campaign "Book now" preset (batch 3, B11). A Marketing template whose URL
 * button is the tracked campaign link `${origin}/r/{{1}}`
 * (src/lib/broadcasts/tracking.ts trackedButtonIndex): each recipient's
 * button gets its own click token, /r/<token> records the click in
 * broadcast_clicks and redirects to the campaign's destination, which the
 * campaign's personalise step can set to a booking page. A booking the
 * contact confirms within 7 days of the click is credited to the campaign
 * (src/lib/appointments/attribution.ts).
 *
 * Kept apart from template-library.ts (other work edits it); that file adds
 * these entries with one call. Copy: TemplateLibrary.<slug>.
 */
import { getT } from '@/lib/i18n/translate';
import { appOrigin } from '@/lib/broadcasts/tracking';
import type { LibraryTemplate } from './template-library';

export const BOOK_NOW_SLUG = 'appointment_book_now';

/** The tracked button URL for this origin (the browser's own origin in the gallery, APP_URL on the server). */
export function trackedBookingUrl(origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : appOrigin());
  return `${base.replace(/\/+$/, '')}/r/{{1}}`;
}

/** The booking presets, in gallery order. */
export function bookingLibraryTemplates(origin?: string): LibraryTemplate[] {
  const t = getT(`TemplateLibrary.${BOOK_NOW_SLUG}`);
  return [{
    slug: BOOK_NOW_SLUG,
    industry: 'services',
    category: 'Marketing',
    title: t('title'),
    description: t('description'),
    name: BOOK_NOW_SLUG,
    header: { type: 'text', text: t('header') },
    body_text: t('body', { v1: '{{1}}', v2: '{{2}}' }),
    footer_text: t('footer'),
    buttons: [{ type: 'URL', text: t('buttons.b1'), url: trackedBookingUrl(origin) }],
    sample_values: { body: t('samples').split('|').map((s) => s.trim()) },
  }];
}
