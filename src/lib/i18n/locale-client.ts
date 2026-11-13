'use client';

import { authFetch } from '@/lib/auth/client';
import type { AppLocale } from './locales';

export interface LocaleState {
  language: AppLocale | null;
  workspace_language: AppLocale | null;
  effective: AppLocale;
  changed: boolean;
}

/**
 * Ask the server for this member's interface language; it refreshes the
 * locale cookie. Returns whether the page must reload its messages.
 */
export async function syncLocale(): Promise<LocaleState | null> {
  try {
    const response = await authFetch('/api/account/locale', { cache: 'no-store' });
    return response.ok ? ((await response.json()) as LocaleState) : null;
  } catch {
    return null;
  }
}

/** Store the member's own language (null follows the workspace default). */
export async function saveLocale(language: AppLocale | null): Promise<LocaleState> {
  const response = await authFetch('/api/account/locale', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
  if (!response.ok) throw new Error('locale');
  return (await response.json()) as LocaleState;
}
