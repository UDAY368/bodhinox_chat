import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

import { deploymentLocale, isAppLocale, LOCALE_COOKIE } from '@/lib/i18n/locales';

export default getRequestConfig(async () => {
  // The member's language (their own choice, else the workspace default) is
  // mirrored into a cookie by /api/account/locale; without it, the
  // deployment's NEXT_PUBLIC_APP_LOCALE, defaulting to 'en' (next-intl's
  // documented "without i18n routing" setup).
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isAppLocale(chosen) ? chosen : deploymentLocale();

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages
  };
});
