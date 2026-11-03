// /book/<slug>: the anonymous booking page (design section 5.1). Outside the
// (auth) and (dashboard) groups so signed-in and anonymous visitors both see
// it; no-referrer and noindex as /join does.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('BookingPublic');
  return { title: t('metaTitle'), referrer: 'no-referrer', robots: { index: false, follow: false } };
}

export default function BookLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen justify-center bg-background px-4 py-10">{children}</div>;
}
