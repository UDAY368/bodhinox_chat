/**
 * The public shop's frame: theme colors and fonts as CSS variables, an
 * announcement bar, the header (logo or name, the shop's menu, cart), the
 * footer (text, links, store pages, contact details, social links) and a
 * floating WhatsApp chat button. Phone first: one compact header row with
 * the menu folded into a "Menu" button, a 44px tap target for every control.
 *
 * Each template picks its own header (logo centred with the menu below, logo
 * left with the menu inline, minimal with the search first, or a bold color
 * band) and footer (link columns, centred and minimal, or a dark band). The
 * frame also carries the template's product card and product page styles as
 * data attributes (data-card, data-product) for the grids and layouts inside.
 *
 * The frame is a CSS container, and the shop's components use container
 * breakpoints (@2xl, @3xl, @5xl), so the theme editor's phone and desktop
 * previews lay out exactly like the live shop at those widths.
 */
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Menu, MessageCircle, User } from 'lucide-react';
import type { PublicShop } from '@/lib/commerce/public-shop';
import { POLICY_SLUGS, type ShopFooter, type ShopMenuLink } from '@/lib/commerce/shop-sections';
import { themeCssVars, type ResolvedShopTheme, type ShopLayout } from '@/lib/commerce/shop-templates';
import { CartButton } from './cart-button';
import { LiveBeacon } from './live-beacon';
import { ReferralCapture } from './referral-capture';
import { SHOP_FONT_CLASSES } from './shop-fonts';
import { ShopSearch } from './shop-search';
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

const heading = { fontFamily: 'var(--shop-font-heading)' } as const;
const navLink = 'rounded-[var(--shop-radius)] px-3 py-2 hover:bg-black/5';

/** Header colors per style: the band uses the brand color, the rest the surface or page color. */
const HEADER_TONE: Record<ShopLayout['header'], string> = {
  centered: 'border-b border-black/5 bg-[var(--shop-surface)]/95 backdrop-blur',
  inline: 'border-b border-black/5 bg-[var(--shop-surface)]/95 backdrop-blur',
  minimal: 'border-b border-black/5 bg-[var(--shop-bg)]/95 backdrop-blur',
  band: 'bg-[var(--shop-primary)] text-[var(--shop-on-primary)] shadow-sm',
};

export function ShopFrameView({ shop, t, children, preview = false }: { shop: FrameShop; t: ShopT; children: ReactNode; preview?: boolean }) {
  const base = `/s/${shop.handle}`;
  const { layout } = shop.theme;
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
  const hasContact = !!(contact.phone || contact.email || contact.address || contact.hours);
  const searchFirst = layout.header === 'minimal';

  const logo = (
    <Link href={base} className="flex min-w-0 items-center gap-2" aria-label={t('home')}>
      {shop.logoUrl
        // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
        ? <img src={shop.logoUrl} alt={shop.name} className="h-9 w-auto max-w-[160px] object-contain" />
        : <span className={`truncate font-semibold ${layout.header === 'centered' ? 'text-xl @2xl:text-2xl' : 'text-lg'}`} style={heading}>{shop.name}</span>}
    </Link>
  );
  const menuFolded = (alwaysFolded: boolean) => (
    <details className={`relative ${alwaysFolded ? '' : '@3xl:hidden'}`}>
      <summary className="flex h-11 cursor-pointer list-none items-center gap-1 rounded-[var(--shop-radius)] px-3 hover:bg-black/5">
        <Menu className="size-5" aria-hidden /><span className="sr-only">{t('menu')}</span>
      </summary>
      <div className="absolute left-0 top-12 z-30 flex min-w-48 flex-col rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-2 text-[var(--shop-text)] shadow-lg ring-1 ring-black/10">
        {menu.map((item) => <ShopLink key={`${item.label}${item.link}`} link={item.link} base={base} className={`${navLink} flex min-h-11 items-center`}>{item.label}</ShopLink>)}
      </div>
    </details>
  );
  const menuInline = (className: string) => (
    <div className={className}>
      {menu.map((item) => <ShopLink key={`${item.label}${item.link}`} link={item.link} base={base} className={navLink}>{item.label}</ShopLink>)}
    </div>
  );
  const icons = (
    <div className="flex items-center gap-1">
      <Link href={`${base}/account`} aria-label={t('account.link')} className="grid size-11 place-items-center rounded-full hover:bg-black/5">
        <User className="size-5" aria-hidden />
      </Link>
      <CartButton handle={shop.handle} label={t('cart')} />
    </div>
  );
  const search = (
    <ShopSearch handle={shop.handle} preview={preview}
      labels={{ label: t('search.label'), placeholder: t('search.placeholder'), submit: t('search.submit'), suggestions: t('search.suggestions'), noMatches: t('search.noMatches') }} />
  );

  let header: ReactNode;
  if (layout.header === 'centered') {
    // Menu button left, logo centred, account and cart right; on wide screens the menu sits on its own row below.
    header = (
      <>
        <div className="mx-auto grid h-14 max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 @2xl:h-20">
          <nav aria-label={t('menu')} className="justify-self-start text-sm">{menuFolded(false)}</nav>
          {logo}
          <div className="justify-self-end">{icons}</div>
        </div>
        <nav aria-label={t('menu')} className="hidden border-t border-black/5 @3xl:block">
          {menuInline('mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-1 px-4 py-1 text-sm uppercase tracking-wide')}
        </nav>
      </>
    );
  } else if (searchFirst) {
    // Search is the header's main control: logo, search and cart in one row on wide screens; search on its own row on phones.
    header = (
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <nav aria-label={t('menu')} className="text-sm">{menuFolded(true)}</nav>
        {logo}
        <div className="order-last w-full @3xl:order-none @3xl:w-auto @3xl:flex-1">{search}</div>
        <div className="ml-auto">{icons}</div>
      </div>
    );
  } else {
    // inline and band: logo left, the menu inline on wide screens, folded on phones.
    header = (
      <div className={`mx-auto flex max-w-6xl items-center gap-3 px-4 ${layout.header === 'band' ? 'h-16 @2xl:h-20' : 'h-14 @2xl:h-16'}`}>
        {logo}
        <nav className="ml-auto flex items-center gap-1 text-sm" aria-label={t('menu')}>
          {menuInline(`hidden items-center gap-1 @3xl:flex ${layout.header === 'band' ? 'font-semibold' : ''}`)}
          {menuFolded(false)}
        </nav>
        {icons}
      </div>
    );
  }

  const footerLinks = [...shop.footer.links, ...pageLinks];
  const linkClass = 'inline-flex min-h-11 items-center hover:underline @2xl:min-h-9';
  const socialLinks = social.length > 0 && (
    <div className={`mt-3 flex flex-wrap items-center gap-2 ${layout.footer === 'centered' ? 'justify-center' : ''}`}>
      {social.map(({ href, label }) => (
        <a key={label} href={href} target="_blank" rel="noopener noreferrer nofollow"
          className="inline-flex h-11 items-center rounded-full border border-current/20 px-4 hover:bg-black/5">{label}</a>
      ))}
    </div>
  );
  const contactBlock = hasContact && (
    <address className="flex flex-col gap-1 not-italic">
      <p className="font-semibold">{t('contactTitle')}</p>
      {contact.phone && <a href={`tel:${contact.phone.replace(/[^+0-9]/g, '')}`} className="hover:underline">{contact.phone}</a>}
      {contact.email && <a href={`mailto:${contact.email}`} className="break-all hover:underline">{contact.email}</a>}
      {contact.address && <p className="whitespace-pre-line opacity-80">{contact.address}</p>}
      {contact.hours && <p className="opacity-80">{contact.hours}</p>}
    </address>
  );

  const footer = layout.footer === 'centered' ? (
    <footer className="border-t border-black/5">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-4 py-10 text-center text-sm">
        <p className="text-lg font-semibold" style={heading}>{shop.name}</p>
        <p className="whitespace-pre-line opacity-80">{shop.footer.text ?? t('footerNote')}</p>
        <ul className="flex flex-wrap justify-center gap-x-4">
          {[...footerLinks, ...policyLinks].map((item) => (
            <li key={`${item.label}${item.link}`}><ShopLink link={item.link} base={base} className={linkClass}>{item.label}</ShopLink></li>
          ))}
        </ul>
        {contactBlock}
        {socialLinks}
      </div>
    </footer>
  ) : (
    // columns, or the dark band (page text color as the background: the template's text/background pair keeps its contrast).
    <footer className={layout.footer === 'dark' ? 'bg-[var(--shop-text)] text-[var(--shop-bg)]' : 'border-t border-black/5 bg-[var(--shop-surface)]'}>
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 text-sm @2xl:grid-cols-2 @5xl:grid-cols-4">
        <div>
          <p className="font-semibold" style={heading}>{shop.name}</p>
          <p className="mt-1 whitespace-pre-line opacity-80">{shop.footer.text ?? t('footerNote')}</p>
          {socialLinks}
        </div>
        {footerLinks.length > 0 && (
          <ul className="flex flex-col">
            {footerLinks.map((item) => (
              <li key={`${item.label}${item.link}`}><ShopLink link={item.link} base={base} className={linkClass}>{item.label}</ShopLink></li>
            ))}
          </ul>
        )}
        <ul className="flex flex-col">
          {policyLinks.map((item) => (
            <li key={item.link}><ShopLink link={item.link} base={base} className={linkClass}>{item.label}</ShopLink></li>
          ))}
        </ul>
        {contactBlock}
      </div>
    </footer>
  );

  return (
    <div style={style} className={`shop-a11y @container min-h-screen bg-[var(--shop-bg)] text-[var(--shop-text)] ${SHOP_FONT_CLASSES}`}
      data-template={shop.theme.template} data-header={layout.header} data-card={layout.card} data-product={layout.product} data-footer={layout.footer}>
      <a href="#shop-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-[var(--shop-radius)] focus:bg-[var(--shop-surface)] focus:px-4 focus:py-3 focus:text-sm focus:font-medium">{t('skipToContent')}</a>
      {shop.theme.announcement && (
        <p className={`px-4 py-2 text-center text-xs font-medium @2xl:text-sm ${layout.header === 'band'
          ? 'bg-[var(--shop-accent)] text-[var(--shop-on-accent)]' : 'bg-[var(--shop-primary)] text-[var(--shop-on-primary)]'}`}>
          {shop.theme.announcement}
        </p>
      )}
      <header className={`sticky top-0 z-20 ${HEADER_TONE[layout.header]}`}>{header}</header>
      {!searchFirst && <div className="mx-auto max-w-6xl px-4 pt-3">{search}</div>}
      <main id="shop-main" tabIndex={-1} className="mx-auto max-w-6xl px-4 pb-24 pt-4 outline-none @2xl:pt-6">{children}</main>
      {footer}
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
  const consent = { title: t('consent.title'), text: t('consent.text'), accept: t('consent.accept'), decline: t('consent.decline') };
  return <ShopFrameView shop={shop} t={t as unknown as ShopT}><ReferralCapture handle={shop.handle} labels={consent} /><LiveBeacon handle={shop.handle} />{children}</ShopFrameView>;
}
