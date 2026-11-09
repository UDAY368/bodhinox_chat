// /contact: the address for privacy, data deletion and support questions
// (SUPPORT_EMAIL). Rendered per request so the address can change without a build.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { supportEmail } from '../contact-email';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Marketing.legal');
  return { title: t('contactTitle') };
}

export default async function ContactPage() {
  const t = await getTranslations('Marketing.legal');
  const email = supportEmail();
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-12 text-[15px]">
      <h2 className="text-2xl font-semibold tracking-tight">{t('contactTitle')}</h2>
      {email ? (
        <>
          <p>
            {t('contactEmail')}{' '}
            <a data-testid="support-email" href={`mailto:${email}`} className="text-primary underline underline-offset-2">
              {email}
            </a>
          </p>
          <p className="text-muted-foreground">{t('contactResponse')}</p>
        </>
      ) : (
        <p className="text-muted-foreground">{t('contactUnset')}</p>
      )}
    </div>
  );
}
