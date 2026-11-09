import { getT } from '@/lib/i18n/translate';

/**
 * Subjects and bodies of the account emails, read from the AuthEmails message catalogue.
 *
 * Bodhinox has no per-user or per-request locale: the interface language is the build locale
 * (NEXT_PUBLIC_APP_LOCALE), so that is the language the recipient used to sign up and the one
 * these emails use. Unknown or unset locales fall back to English (see getT).
 */
export interface AuthEmailContent {
  subject: string;
  text: string;
}

const t = (key: string, values?: Record<string, string>) => getT('AuthEmails')(key, values);

export function verificationEmail(purpose: 'verify' | 'reset', link: string): AuthEmailContent {
  return purpose === 'reset'
    ? { subject: t('resetSubject'), text: t('resetBody', { link }) }
    : { subject: t('verifySubject'), text: t('verifyBody', { link }) };
}

export function existingAccountEmail(signIn: string, joinLink?: string): AuthEmailContent {
  const join = joinLink ? `\n${t('existingJoin', { link: joinLink })}` : '';
  return { subject: t('existingSubject'), text: t('existingBody', { signIn, join }) };
}

export function emailChangeConfirmEmail(link: string): AuthEmailContent {
  return { subject: t('changeConfirmSubject'), text: t('changeConfirmBody', { link }) };
}

export function emailChangeNoticeEmail(newEmail: string): AuthEmailContent {
  return { subject: t('changeNoticeSubject'), text: t('changeNoticeBody', { newEmail }) };
}

export function deliveryTestEmail(): AuthEmailContent {
  return { subject: t('deliveryTestSubject'), text: t('deliveryTestBody') };
}
