// /terms: the terms of service from content/legal/terms.md, marked DRAFT until
// the operator replaces them. Rendered at build time.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { LegalPage } from '../legal-page';

export const dynamic = 'force-static';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Marketing.legal');
  return { title: t('termsTitle') };
}

export default function TermsPage() {
  return <LegalPage name="terms" />;
}
