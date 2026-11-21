import { getT } from '@/lib/i18n/translate';
import { getLocaleT } from '@/lib/i18n/email-locale';
import type { AppLocale } from '@/lib/i18n/locales';

/**
 * Subjects and bodies of the account emails, read from the AuthEmails message catalogue.
 *
 * When the recipient is a known member, the caller passes their language (their own choice,
 * else their workspace's default; see userEmailLocale in service.ts). Otherwise (a new signup)
 * the email uses the build locale (NEXT_PUBLIC_APP_LOCALE), English when unset (see getT).
 */
export interface AuthEmailContent {
  subject: string;
  text: string;
}

function translator(locale?: AppLocale) {
  const t = locale ? getLocaleT(locale, 'AuthEmails') : getT('AuthEmails');
  return (key: string, values?: Record<string, string>) => t(key, values);
}

export function verificationEmail(purpose: 'verify' | 'reset', link: string, locale?: AppLocale): AuthEmailContent {
  const t = translator(locale);
  return purpose === 'reset'
    ? { subject: t('resetSubject'), text: t('resetBody', { link }) }
    : { subject: t('verifySubject'), text: t('verifyBody', { link }) };
}

export function existingAccountEmail(signIn: string, joinLink?: string, locale?: AppLocale): AuthEmailContent {
  const t = translator(locale);
  const join = joinLink ? `\n${t('existingJoin', { link: joinLink })}` : '';
  return { subject: t('existingSubject'), text: t('existingBody', { signIn, join }) };
}

export function emailChangeConfirmEmail(link: string, locale?: AppLocale): AuthEmailContent {
  const t = translator(locale);
  return { subject: t('changeConfirmSubject'), text: t('changeConfirmBody', { link }) };
}

export function emailChangeNoticeEmail(newEmail: string, locale?: AppLocale): AuthEmailContent {
  const t = translator(locale);
  return { subject: t('changeNoticeSubject'), text: t('changeNoticeBody', { newEmail }) };
}

export function deliveryTestEmail(locale?: AppLocale): AuthEmailContent {
  const t = translator(locale);
  return { subject: t('deliveryTestSubject'), text: t('deliveryTestBody') };
}
