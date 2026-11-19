import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { UnsubscribeForm } from '@/components/shop-public/unsubscribe-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ t?: string }> };

/**
 * The page an email's unsubscribe link opens. Opening it changes nothing (mail scanners open links): the button does. It stands
 * outside /s/<handle> on purpose, so a password or coming-soon shop can still be unsubscribed from.
 */
export default async function UnsubscribePage({ params, searchParams }: Props) {
  const { handle } = await params;
  const { t: token } = await searchParams;
  const t = await getTranslations('ShopPublic.unsubscribe');
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="opacity-80">{t('help')}</p>
      <UnsubscribeForm handle={handle} token={typeof token === 'string' ? token : ''} />
    </main>
  );
}
