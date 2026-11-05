// /privacy: the privacy policy from content/legal/privacy.md, marked DRAFT until
// the operator replaces it. Rendered at build time.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { LegalPage } from '../legal-page';

export const dynamic = 'force-static';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Marketing.legal');
  return { title: t('privacyTitle') };
}

export default function PrivacyPage() {
  return <LegalPage name="privacy" />;
}
