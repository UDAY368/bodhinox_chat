// The help and legal texts (content/help, content/legal) exist in English only.
// In any other locale those pages say so above the text, instead of silently
// mixing a translated shell with English content.
import { getLocale, getTranslations } from 'next-intl/server';

export async function englishOnlyNote(): Promise<string | null> {
  const locale = await getLocale();
  if (locale.split('-')[0].toLowerCase() === 'en') return null;
  return (await getTranslations('Marketing.help'))('englishOnly');
}
