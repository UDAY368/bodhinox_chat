// The landing page body, rendered at `/` (src/app/page.tsx) for signed-out visitors.

import Link from 'next/link';
import { Bot, CalendarCheck, Inbox, ShoppingBag, Workflow, UsersRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

const FEATURES = [
  { id: 'inbox', icon: Inbox },
  { id: 'flows', icon: Workflow },
  { id: 'ai', icon: Bot },
  { id: 'crm', icon: UsersRound },
  { id: 'commerce', icon: ShoppingBag },
  { id: 'appointments', icon: CalendarCheck },
] as const;

export async function Landing() {
  const t = await getTranslations('Marketing.landing');
  return (
    <div>
      <section className="mx-auto max-w-4xl px-4 py-20 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{t('headline')}</h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">{t('subhead')}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/signup" className="rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground hover:bg-primary/90">
            {t('ctaPrimary')}
          </Link>
          <Link href="/pricing" className="rounded-lg border border-border px-5 py-2.5 font-medium hover:bg-muted">
            {t('ctaSecondary')}
          </Link>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-20 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ id, icon: Icon }) => (
          <div key={id} className="rounded-xl border border-border bg-card p-5">
            <Icon className="size-5 text-primary" />
            <h2 className="mt-3 font-semibold">{t(`features.${id}.title`)}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{t(`features.${id}.body`)}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
