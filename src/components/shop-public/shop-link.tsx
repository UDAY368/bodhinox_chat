import type { ReactNode } from 'react';
import Link from 'next/link';
import { shopHref } from '@/lib/commerce/shop-sections';

/** Translations of the ShopPublic namespace, from next-intl on the server (getTranslations) or the client (useTranslations). */
export type ShopT = (key: string, values?: Record<string, string | number>) => string;

/** A stored shop link: a path inside the shop (next/link) or an https URL (new tab, no referrer, nofollow). */
export function ShopLink({ link, base, className, children }: { link: string | null; base: string; className?: string; children: ReactNode }) {
  const target = shopHref(link, base);
  if (!target) return <span className={className}>{children}</span>;
  if (target.external) return (
    <a href={target.href} target="_blank" rel="noopener noreferrer nofollow" className={className}>{children}</a>
  );
  return <Link href={target.href} className={className}>{children}</Link>;
}
