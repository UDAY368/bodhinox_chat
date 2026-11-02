/**
 * Language codes Meta accepts for WhatsApp message templates.
 *
 * A template is submitted once per language, and the code is part of its
 * identity (name + language). Labels are English with the endonym in
 * parentheses where it helps someone recognise their own language. The
 * list is sorted by label so a picker can render it as-is.
 */

export interface TemplateLanguage {
  code: string;
  label: string;
}

const LANGUAGES: TemplateLanguage[] = [
  { code: 'af', label: 'Afrikaans' },
  { code: 'sq', label: 'Albanian (Shqip)' },
  { code: 'ar', label: 'Arabic (العربية)' },
  { code: 'az', label: 'Azerbaijani (Azərbaycan)' },
  { code: 'bn', label: 'Bengali (বাংলা)' },
  { code: 'bg', label: 'Bulgarian (Български)' },
  { code: 'ca', label: 'Catalan (Català)' },
  { code: 'zh_CN', label: 'Chinese, Simplified (简体中文)' },
  { code: 'zh_HK', label: 'Chinese, Hong Kong (繁體中文)' },
  { code: 'zh_TW', label: 'Chinese, Traditional (繁體中文)' },
  { code: 'hr', label: 'Croatian (Hrvatski)' },
  { code: 'cs', label: 'Czech (Čeština)' },
  { code: 'da', label: 'Danish (Dansk)' },
  { code: 'nl', label: 'Dutch (Nederlands)' },
  { code: 'en', label: 'English' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'en_US', label: 'English (US)' },
  { code: 'et', label: 'Estonian (Eesti)' },
  { code: 'fil', label: 'Filipino' },
  { code: 'fi', label: 'Finnish (Suomi)' },
  { code: 'fr', label: 'French (Français)' },
  { code: 'fr_FR', label: 'French, France (Français)' },
  { code: 'ka', label: 'Georgian (ქართული)' },
  { code: 'de', label: 'German (Deutsch)' },
  { code: 'el', label: 'Greek (Ελληνικά)' },
  { code: 'gu', label: 'Gujarati (ગુજરાતી)' },
  { code: 'ha', label: 'Hausa' },
  { code: 'he', label: 'Hebrew (עברית)' },
  { code: 'hi', label: 'Hindi (हिन्दी)' },
  { code: 'hu', label: 'Hungarian (Magyar)' },
  { code: 'id', label: 'Indonesian (Bahasa Indonesia)' },
  { code: 'ga', label: 'Irish (Gaeilge)' },
  { code: 'it', label: 'Italian (Italiano)' },
  { code: 'ja', label: 'Japanese (日本語)' },
  { code: 'kn', label: 'Kannada (ಕನ್ನಡ)' },
  { code: 'kk', label: 'Kazakh (Қазақ)' },
  { code: 'rw_RW', label: 'Kinyarwanda' },
  { code: 'ko', label: 'Korean (한국어)' },
  { code: 'ky_KG', label: 'Kyrgyz (Кыргызча)' },
  { code: 'lo', label: 'Lao (ລາວ)' },
  { code: 'lv', label: 'Latvian (Latviešu)' },
  { code: 'lt', label: 'Lithuanian (Lietuvių)' },
  { code: 'mk', label: 'Macedonian (Македонски)' },
  { code: 'ms', label: 'Malay (Bahasa Melayu)' },
  { code: 'ml', label: 'Malayalam (മലയാളം)' },
  { code: 'mr', label: 'Marathi (मराठी)' },
  { code: 'nb', label: 'Norwegian (Norsk bokmål)' },
  { code: 'fa', label: 'Persian (فارسی)' },
  { code: 'pl', label: 'Polish (Polski)' },
  { code: 'pt_BR', label: 'Portuguese, Brazil (Português)' },
  { code: 'pt_PT', label: 'Portuguese, Portugal (Português)' },
  { code: 'pa', label: 'Punjabi (ਪੰਜਾਬੀ)' },
  { code: 'ro', label: 'Romanian (Română)' },
  { code: 'ru', label: 'Russian (Русский)' },
  { code: 'sr', label: 'Serbian (Српски)' },
  { code: 'sk', label: 'Slovak (Slovenčina)' },
  { code: 'sl', label: 'Slovenian (Slovenščina)' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'es_AR', label: 'Spanish, Argentina (Español)' },
  { code: 'es_MX', label: 'Spanish, Mexico (Español)' },
  { code: 'es_ES', label: 'Spanish, Spain (Español)' },
  { code: 'sw', label: 'Swahili (Kiswahili)' },
  { code: 'sv', label: 'Swedish (Svenska)' },
  { code: 'ta', label: 'Tamil (தமிழ்)' },
  { code: 'te', label: 'Telugu (తెలుగు)' },
  { code: 'th', label: 'Thai (ไทย)' },
  { code: 'tr', label: 'Turkish (Türkçe)' },
  { code: 'uk', label: 'Ukrainian (Українська)' },
  { code: 'ur', label: 'Urdu (اردو)' },
  { code: 'uz', label: 'Uzbek (Oʻzbek)' },
  { code: 'vi', label: 'Vietnamese (Tiếng Việt)' },
  { code: 'zu', label: 'Zulu (isiZulu)' },
];

export const TEMPLATE_LANGUAGES: readonly TemplateLanguage[] = [...LANGUAGES].sort((a, b) =>
  a.label.localeCompare(b.label, 'en'),
);

const CODES = new Set(TEMPLATE_LANGUAGES.map((l) => l.code));

export function isTemplateLanguage(code: string): boolean {
  return CODES.has(code);
}

/** Template language that matches each app build locale (NEXT_PUBLIC_APP_LOCALE). */
const APP_LOCALE_TEMPLATE_LANGUAGE: Record<string, string> = {
  en: 'en_US',
  es: 'es',
  pt: 'pt_BR',
  ko: 'ko',
};

/**
 * Language code to prefill for templates written in the app's own build
 * locale. Unknown or unset locales fall back to `en_US`, like getT does.
 */
export function templateLanguageForAppLocale(locale = process.env.NEXT_PUBLIC_APP_LOCALE ?? ''): string {
  return APP_LOCALE_TEMPLATE_LANGUAGE[locale] ?? 'en_US';
}
