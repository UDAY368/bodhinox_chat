import { createTranslator } from 'next-intl';
import activeMessages from '@app-messages';

/**
 * Translator for code that runs outside React — API route handlers,
 * validators shared by client and server, starter templates, and so on.
 * Components should keep using `useTranslations` / `getTranslations`.
 *
 * The locale is fixed at build time (NEXT_PUBLIC_APP_LOCALE, see
 * src/i18n/request.ts), so this resolves one catalogue per process.
 * Unknown or unset locales fall back to English, which is also what the
 * test suite sees.
 */

type Catalogue = Record<string, unknown>;

function loadCatalogue(): { locale: string; messages: Catalogue } {
  const env = process.env.NEXT_PUBLIC_APP_LOCALE ?? '';
  const locale = ['en', 'pt', 'es', 'ko'].includes(env) ? env : 'en';
  return { locale, messages: activeMessages as Catalogue };
}

let cached: { locale: string; messages: Catalogue } | null = null;

export type TranslateValues = Record<string, string | number | Date>;
export type Translate = (key: string, values?: TranslateValues) => string;

/**
 * Returns a `t(key, values)` bound to `namespace` (e.g. `'Api'`,
 * `'Validation.flows'`). Messages use ICU syntax like the rest of the
 * catalogue; literal WhatsApp `{{1}}` must be passed in as a value.
 */
export function getT(namespace: string): Translate {
  // Made on the first call, not here: many modules call getT at load time, and in the browser
  // the catalogue arrives when the root layout renders (src/i18n/browser-messages.ts). Until it
  // has arrived nothing is cached, so the first translation after it is right.
  let t: ((key: string, values?: TranslateValues) => string) | null = null;
  return (key, values) => {
    if (!t) {
      cached ??= loadCatalogue();
      if (!Object.keys(cached.messages).length) return `${namespace}.${key}`;
      t = createTranslator({
        locale: cached.locale,
        messages: cached.messages,
        namespace: namespace as never,
      }) as unknown as (key: string, values?: TranslateValues) => string;
    }
    return t(key, values);
  };
}
