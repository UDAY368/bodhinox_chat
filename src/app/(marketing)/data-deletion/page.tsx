// /data-deletion: how people and businesses ask for their data to be deleted
// (content/legal/data-deletion.md), and the status page Meta links to after a
// Data Deletion Request Callback (/data-deletion?code=..., see
// src/app/api/meta/data-deletion/route.ts). Rendered per request for the lookup.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { CONFIRMATION_CODE, findDeletionRequest, type DeletionRequestStatus } from '@/lib/meta/data-deletion';
import { LegalPage } from '../legal-page';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Marketing.legal');
  return { title: t('dataDeletionTitle') };
}

export default async function DataDeletionPage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const { code } = await searchParams;
  const value = typeof code === 'string' && CONFIRMATION_CODE.test(code) ? code : null;
  if (code === undefined) return <LegalPage name="data-deletion" />;
  const t = await getTranslations('Marketing.legal');
  let found: DeletionRequestStatus | null = null;
  try {
    found = value ? await findDeletionRequest(value) : null;
  } catch {
    found = null;
  }
  const date = found ? found.createdAt.toISOString().slice(0, 10) : '';
  return (
    <LegalPage name="data-deletion">
      <section role="status" data-testid="deletion-status" className="mb-8 rounded-lg border border-border px-4 py-3 text-sm">
        <h2 className="mb-1 font-semibold">{t('statusHeading')}</h2>
        <p>
          {!found || !value
            ? t('statusUnknown')
            : found.status === 'completed'
              ? t('statusCompleted', { code: value, date })
              : t('statusReceived', { code: value, date })}
        </p>
      </section>
    </LegalPage>
  );
}
