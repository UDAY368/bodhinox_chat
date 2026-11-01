// ============================================================
// Campaign click tracking. A template whose URL button is exactly
// `<APP_URL>/r/{{1}}` is "trackable": each recipient's button gets its
// own token, and /r/<token> records the click and redirects to the
// campaign's stored HTTPS destination (never a URL from the request,
// so the redirect cannot be abused as an open redirect).
// ============================================================

import type { MessageTemplate } from '@/types';

/** The app origin the tracking button must point at. */
export function appOrigin(): string {
  return new URL(process.env.APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').origin;
}

/** Index of the template's tracking URL button, or -1 when the template is not trackable. */
export function trackedButtonIndex(template: Pick<MessageTemplate, 'buttons'> | null | undefined, origin = appOrigin()): number {
  return (template?.buttons ?? []).findIndex((b) => b.type === 'URL' && b.url === `${origin}/r/{{1}}`);
}

/** A tracked destination must be an absolute HTTPS URL without credentials. */
export function validTrackedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && value.length <= 2048;
  } catch {
    return false;
  }
}

export const CLICK_TOKEN = /^[0-9a-f]{32}$/;
/** Fills the link button of a test send; /r/test explains that test links are not tracked. */
export const TEST_CLICK_TOKEN = 'test';
