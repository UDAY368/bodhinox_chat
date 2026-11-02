import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { getT } from '@/lib/i18n/translate';
import { libraryIndustryLabel, listLibraryTemplates } from '@/lib/whatsapp/template-library';
import { templateLanguageForAppLocale } from '@/lib/whatsapp/template-languages';

const t = getT('Api');

/**
 * GET /api/whatsapp/templates/library
 *
 * Returns the premade template library (src/lib/whatsapp/template-library.ts)
 * with full payload fields — it is static, code-shipped content with no
 * account data — plus the language code that matches this build's locale
 * so the editor can prefill it. Copying an entry only fills the editor;
 * saving and submitting go through the existing template routes.
 *
 * Available to any signed-in user.
 */
export async function GET() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: t('common.unauthorized') },
      { status: 401 }
    );
  }
  const templates = listLibraryTemplates().map((tpl) => ({
    ...tpl,
    industry_label: libraryIndustryLabel(tpl.industry),
  }));
  return NextResponse.json({ language: templateLanguageForAppLocale(), templates });
}
