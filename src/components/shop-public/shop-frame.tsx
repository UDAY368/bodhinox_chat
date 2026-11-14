/**
 * The public shop's frame: theme colors and fonts as CSS variables, an
 * announcement bar, the header (logo or name, menu, cart), the footer with
 * social links, and a floating WhatsApp chat button. Phone first: one
 * compact header row, a 44px tap target for every control.
 */
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { MessageCircle } from 'lucide-react';
import type { PublicShop } from '@/lib/commerce/public-shop';
import { themeCssVars } from '@/lib/commerce/shop-templates';
import { CartButton } from './cart-button';

export async function ShopFrame({ shop, children }: { shop: PublicShop; children: ReactNode }) {
  const t = await getTranslations('ShopPublic');
  const base = `/s/${shop.handle}`;
  const style = { ...themeCssVars(shop.theme), fontFamily: 'var(--shop-font-body)' } as CSSProperties;
  const social = [
    { href: shop.theme.social.instagram, label: 'Instagram' },
    { href: shop.theme.social.facebook, label: 'Facebook' },
    { href: shop.theme.social.youtube, label: 'YouTube' },
  ].filter((s): s is { href: string; label: string } => !!s.href);
  return (
    <div style={style} className="min-h-screen bg-[var(--shop-bg)] text-[var(--shop-text)]" data-template={shop.theme.template}>
      {shop.theme.announcement && (
        <p className="bg-[var(--shop-primary)] px-4 py-2 text-center text-xs font-medium text-[var(--shop-on-primary)] sm:text-sm">
          {shop.theme.announcement}
        </p>
      )}
      <header className="sticky top-0 z-20 border-b border-black/5 bg-[var(--shop-surface)]/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:h-16">
          <Link href={base} className="flex min-w-0 items-center gap-2" aria-label={t('home')}>
            {shop.logoUrl
              // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
              ? <img src={shop.logoUrl} alt={shop.name} className="h-9 w-auto max-w-[160px] object-contain" />
              : <span className="truncate text-lg font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{shop.name}</span>}
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <Link href={`${base}/all`} className="hidden rounded-[var(--shop-radius)] px-3 py-2 hover:bg-black/5 sm:inline-block">{t('allProducts')}</Link>
            <CartButton handle={shop.handle} label={t('cart')} />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-24 pt-4 sm:pt-6">{children}</main>
      <footer className="border-t border-black/5 bg-[var(--shop-surface)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{shop.name}</p>
            <p className="mt-1 opacity-70">{t('footerNote')}</p>
          </div>
          <div className="flex items-center gap-2">
            {social.map(({ href, label }) => (
              <a key={label} href={href} target="_blank" rel="noopener noreferrer nofollow"
                className="inline-flex h-11 items-center rounded-full border border-black/10 px-4 hover:bg-black/5">
                {label}
              </a>
            ))}
          </div>
        </div>
      </footer>
      {shop.whatsappPhone && (
        <a href={`https://wa.me/${shop.whatsappPhone}`} target="_blank" rel="noopener noreferrer"
          className="fixed bottom-4 right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-[#25d366] px-4 text-sm font-semibold text-black shadow-lg"
          aria-label={t('chatOnWhatsApp')}>
          <MessageCircle className="size-5" aria-hidden />
          <span className="hidden sm:inline">{t('chatOnWhatsApp')}</span>
        </a>
      )}
    </div>
  );
}
