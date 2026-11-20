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
  // Phone first: a narrow column from the top; the step's primary button is pinned to the bottom on phones.
  return <div className="flex min-h-screen justify-center bg-background px-4 pt-6 pb-10 sm:items-start sm:py-12">{children}</div>;
}
