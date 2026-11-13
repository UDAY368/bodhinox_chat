/**
 * The app's interface languages and the cookie that picks one per browser.
 * The cookie only mirrors a stored choice (the member's own language, else the
 * workspace default); /api/account/locale sets it from the database.
 */
export const APP_LOCALES = ['en', 'es', 'ko', 'pt'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export const LOCALE_COOKIE = 'bodhinox_locale';

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}

/** The deployment's default, from NEXT_PUBLIC_APP_LOCALE, else English. */
export function deploymentLocale(): AppLocale {
  const env = process.env.NEXT_PUBLIC_APP_LOCALE;
  return isAppLocale(env) ? env : 'en';
}

/** The member's own choice, else the workspace default, else the deployment default. */
export function effectiveLocale(member: string | null | undefined, workspace: string | null | undefined): AppLocale {
  if (isAppLocale(member)) return member;
  if (isAppLocale(workspace)) return workspace;
  return deploymentLocale();
}
