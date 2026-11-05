// /help: the user help, from content/help/*.md (English; other locales show the
// English text until translations exist). Rendered at build time, so the content
// folder is not needed at runtime. Each section is an anchor (/help#<section>)
// that the in-app "?" links (src/components/help/help-link.tsx) point at.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { HELP_SECTIONS } from '@/components/help/help-link';
import { Markdown, readContent } from '../markdown';

export const dynamic = 'force-static';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Marketing.help');
  return { title: t('title') };
}

export default async function HelpPage() {
  const t = await getTranslations('Marketing.help');
  const sections = HELP_SECTIONS.map((id) => ({ id, source: readContent('help', id) }));
  const titleOf = (source: string) => /^#\s+(.*)$/m.exec(source)?.[1] ?? '';
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 lg:grid-cols-[220px_1fr]">
      <nav aria-label={t('contents')} className="lg:sticky lg:top-6 lg:self-start">
        <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t('contents')}</p>
        <ul className="space-y-1.5 text-sm">
          {sections.map(({ id, source }) => (
            <li key={id}>
              <a href={`#${id}`} className="text-muted-foreground hover:text-foreground">{titleOf(source)}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 space-y-14">
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        {sections.map(({ id, source }) => (
          <section key={id} id={id} className="scroll-mt-6">
            <Markdown source={source} idPrefix={`${id}-`} />
          </section>
        ))}
      </div>
    </div>
  );
}
