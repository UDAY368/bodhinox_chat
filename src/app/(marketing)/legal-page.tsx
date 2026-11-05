import { getTranslations } from 'next-intl/server';

import { Markdown, readContent } from './markdown';

/** A legal document with the DRAFT notice (the text itself also says so). */
export async function LegalPage({ name }: { name: 'privacy' | 'terms' }) {
  const t = await getTranslations('Marketing.legal');
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <p role="note" className="mb-8 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
        {t('draft')}
      </p>
      <Markdown source={readContent('legal', name)} />
    </div>
  );
}
