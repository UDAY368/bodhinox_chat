// /my-booking/<token>: the customer's status page (design section 5.1). The
// token is in the path, so no-referrer; noindex. The title and Open Graph
// data are generic because WhatsApp's link-preview crawler fetches the URL,
// and rendering the page has no side effects (the client loads the booking).

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('BookingManage');
  return {
    title: t('metaTitle'),
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
    openGraph: { title: t('metaTitle') },
  };
}

export default function MyBookingLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen justify-center bg-background px-4 py-10">{children}</div>;
}
