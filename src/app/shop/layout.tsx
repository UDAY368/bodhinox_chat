// /shop/<token>: the customer's storefront link (design E12). The token is in
// the path, so no-referrer; noindex. The title and Open Graph data are generic
// because WhatsApp's link-preview crawler fetches the URL, and rendering the
// page has no side effects (the client loads the session).

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Storefront');
  return {
    title: t('metaTitle'),
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
    openGraph: { title: t('metaTitle') },
  };
}

export default function ShopLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen justify-center bg-background px-4 py-8">{children}</div>;
}
