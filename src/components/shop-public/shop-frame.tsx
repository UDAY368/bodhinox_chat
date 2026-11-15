/**
 * The public shop's frame: theme colors and fonts as CSS variables, an
 * announcement bar, the header (logo or name, the shop's menu, cart), the
 * footer (text, links, store pages, contact details, social links) and a
 * floating WhatsApp chat button. Phone first: one compact header row with
 * the menu folded into a "Menu" button, a 44px tap target for every control.
 *
 * The frame is a CSS container, and the shop's components use container
 * breakpoints (@2xl, @3xl, @5xl), so the theme editor's phone and desktop
 * previews lay out exactly like the live shop at those widths.
 */
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Menu, MessageCircle } from 'lucide-react';
import type { PublicShop } from '@/lib/commerce/public-shop';
import { POLICY_SLUGS, type ShopFooter, type ShopMenuLink } from '@/lib/commerce/shop-sections';
import { themeCssVars, type ResolvedShopTheme } from '@/lib/commerce/shop-templates';
import { CartButton } from './cart-button';
import { ShopLink, type ShopT } from './shop-link';

export interface FrameShop {
  handle: string;
  name: string;
  theme: ResolvedShopTheme;
  logoUrl: string | null;
  whatsappPhone: string | null;
  menu: ShopMenuLink[];
  footer: ShopFooter;
  pages: Record<'about' | 'contact' | 'faq', boolean>;
}

export function ShopFrameView({ shop, t, children, preview = false }: { shop: FrameShop; t: ShopT; children: ReactNode; preview?: boolean }) {
  const base = `/s/${shop.handle}`;
  const style = { ...themeCssVars(shop.theme), fontFamily: 'var(--shop-font-body)' } as CSSProperties;
  const social = [
    { href: shop.theme.social.instagram, label: 'Instagram' },
    { href: shop.theme.social.facebook, label: 'Facebook' },
    { href: shop.theme.social.youtube, label: 'YouTube' },
  ].filter((s): s is { href: string; label: string } => !!s.href);
  const menu = shop.menu.length ? shop.menu : [{ label: t('allProducts'), link: '/all' }];
  const pageLinks = (['about', 'contact', 'faq'] as const).filter((slug) => shop.pages[slug]).map((slug) => ({ label: t(`pages.${slug}`), link: `/pages/${slug}` }));
  const policyLinks = POLICY_SLUGS.map((slug) => ({ label: t(`pages.${slug}`), link: `/pages/${slug}` }));
  const contact = shop.footer.contact;
  const navLink = 'rounded-[var(--shop-radius)] px-3 py-2 hover:bg-black/5';
  return (
    <div style={style} className="@container min-h-screen bg-[var(--shop-bg)] text-[var(--shop-text)]" data-template={shop.theme.template}>
      {shop.theme.announcement && (
        <p className="bg-[var(--shop-primary)] px-4 py-2 text-center text-xs font-medium text-[var(--shop-on-primary)] @2xl:text-sm">
          {shop.theme.announcement}
        </p>
      )}
      <header className="sticky top-0 z-20 border-b border-black/5 bg-[var(--shop-surface)]/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 @2xl:h-16">
          <Link href={base} className="flex min-w-0 items-center gap-2" aria-label={t('home')}>
            {shop.logoUrl
              // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
              ? <img src={shop.logoUrl} alt={shop.name} className="h-9 w-auto max-w-[160px] object-contain" />
              : <span className="truncate text-lg font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{shop.name}</span>}
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-sm" aria-label={t('menu')}>
            <div className="hidden items-center gap-1 @3xl:flex">
              {menu.map((item) => <ShopLink key={`${item.label}${item.link}`} link={item.link} base={base} className={navLink}>{item.label}</ShopLink>)}
            </div>
            <details className="relative @3xl:hidden">
              <summary className="flex h-11 cursor-pointer list-none items-center gap-1 rounded-[var(--shop-radius)] px-3 hover:bg-black/5">
                <Menu className="size-5" aria-hidden /><span className="sr-only">{t('menu')}</span>
              </summary>
              <div className="absolute right-0 top-12 z-30 flex min-w-48 flex-col rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-2 shadow-lg ring-1 ring-black/10">
                {menu.map((item) => <ShopLink key={`${item.label}${item.link}`} link={item.link} base={base} className={`${navLink} flex min-h-11 items-center`}>{item.label}</ShopLink>)}
              </div>
            </details>
            <CartButton handle={shop.handle} label={t('cart')} />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-24 pt-4 @2xl:pt-6">{children}</main>
      <footer className="border-t border-black/5 bg-[var(--shop-surface)]">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 text-sm @2xl:grid-cols-2 @5xl:grid-cols-4">
          <div>
            <p className="font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{shop.name}</p>
            <p className="mt-1 whitespace-pre-line opacity-70">{shop.footer.text ?? t('footerNote')}</p>
            {social.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {social.map(({ href, label }) => (
                  <a key={label} href={href} target="_blank" rel="noopener noreferrer nofollow"
                    className="inline-flex h-11 items-center rounded-full border border-black/10 px-4 hover:bg-black/5">{label}</a>
                ))}
              </div>
            )}
          </div>
          {(shop.footer.links.length > 0 || pageLinks.length > 0) && (
            <ul className="flex flex-col">
              {[...shop.footer.links, ...pageLinks].map((item) => (
                <li key={`${item.label}${item.link}`}><ShopLink link={item.link} base={base} className="inline-flex min-h-9 items-center hover:underline">{item.label}</ShopLink></li>
              ))}
            </ul>
          )}
          <ul className="flex flex-col">
            {policyLinks.map((item) => (
              <li key={item.link}><ShopLink link={item.link} base={base} className="inline-flex min-h-9 items-center hover:underline">{item.label}</ShopLink></li>
            ))}
          </ul>
          {(contact.phone || contact.email || contact.address || contact.hours) && (
            <address className="flex flex-col gap-1 not-italic">
              <p className="font-semibold">{t('contactTitle')}</p>
              {contact.phone && <a href={`tel:${contact.phone.replace(/[^+0-9]/g, '')}`} className="hover:underline">{contact.phone}</a>}
              {contact.email && <a href={`mailto:${contact.email}`} className="break-all hover:underline">{contact.email}</a>}
              {contact.address && <p className="whitespace-pre-line opacity-80">{contact.address}</p>}
              {contact.hours && <p className="opacity-80">{contact.hours}</p>}
            </address>
          )}
        </div>
      </footer>
      {shop.whatsappPhone && (
        <a href={`https://wa.me/${shop.whatsappPhone}`} target="_blank" rel="noopener noreferrer"
          className={`${preview ? 'absolute' : 'fixed'} bottom-4 right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-[#25d366] px-4 text-sm font-semibold text-black shadow-lg`}
          aria-label={t('chatOnWhatsApp')}>
          <MessageCircle className="size-5" aria-hidden />
          <span className="hidden @2xl:inline">{t('chatOnWhatsApp')}</span>
        </a>
      )}
    </div>
  );
}

export async function ShopFrame({ shop, children }: { shop: PublicShop; children: ReactNode }) {
  const t = await getTranslations('ShopPublic');
  return <ShopFrameView shop={shop} t={t as unknown as ShopT}>{children}</ShopFrameView>;
}
