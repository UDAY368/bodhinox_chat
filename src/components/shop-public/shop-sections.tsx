/**
 * The shop's home page sections (store plan Phase 2), drawn from the
 * validated content in shop-sections.ts. Pure and shared: the public home
 * page renders it on the server, and the theme editor's live preview renders
 * the same components in the browser with the draft. Text is rendered by
 * React (escaped); images are our media route or the shop's https URL; links
 * are fixed shop paths or https URLs (ShopLink).
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { BadgeCheck, Banknote, Headset, Leaf, MessageCircle, Play, RotateCcw, ShieldCheck, Star, Truck, type LucideIcon } from 'lucide-react';
import type { PublicProduct } from '@/lib/commerce/public-shop';
import { categoryPath } from '@/lib/commerce/shop-paths';
import { categoryTree, pickCollectionProducts, pickProducts, youtubeId, type FieldValues, type ShopSection, type TrustIcon } from '@/lib/commerce/shop-sections';
import type { ResolvedShopTheme } from '@/lib/commerce/shop-templates';
import { OfferCountdown } from './offer-countdown';
import { cardLabels, ProductCard, ProductGrid } from './product-card';
import { RecentlyViewed } from './recently-viewed';
import { imageSrcSet } from '@/lib/commerce/shop-images';
import { ShopLink, type ShopT } from './shop-link';

export interface SectionContext {
  base: string;
  handle: string;
  theme: ResolvedShopTheme;
  currency: string | null;
  locale: string;
  products: PublicProduct[];
  categories: Array<{ id: string; slug?: string | null; name: string }>;
  tree: Array<{ id: string; slug?: string | null; parentId: string | null; name?: string }>;
  /** Collections that "featured collection" sections name (published ones on the shop; every one in the editor's preview). */
  collections?: Record<string, { slug: string; title: string; productIds: string[] }>;
  whatsappPhone: string | null;
  /** An image ref (https URL or media:<id>) to a URL the page can load. */
  image: (ref: string | null) => string | null;
  t: ShopT;
  /** "Best sellers" products in sales rank order (the home loader); the editor's preview uses its first products instead. */
  bestSellers?: PublicProduct[];
  /** The editor's preview: empty sections show a hint instead of nothing. */
  preview?: boolean;
}

const heading = { fontFamily: 'var(--shop-font-heading)' } as const;
const str = (values: FieldValues, key: string): string | null => (typeof values[key] === 'string' ? values[key] as string : null);

function Title({ children, id }: { children: ReactNode; id?: string }) {
  return <h2 id={id} className="text-xl font-semibold @2xl:text-2xl" style={heading}>{children}</h2>;
}

function Button({ link, base, label, tone = 'primary' }: { link: string | null; base: string; label: string; tone?: 'primary' | 'accent' }) {
  const color = tone === 'accent'
    ? 'bg-[var(--shop-accent)] text-[var(--shop-on-accent)]'
    : 'bg-[var(--shop-primary)] text-[var(--shop-on-primary)]';
  return (
    <ShopLink link={link} base={base} className={`inline-flex h-12 items-center rounded-[var(--shop-radius)] px-6 font-semibold ${color}`}>
      {label}
    </ShopLink>
  );
}

function Empty({ ctx }: { ctx: SectionContext }) {
  if (!ctx.preview) return null;
  return <p className="rounded-[var(--shop-radius)] border border-dashed border-black/20 p-6 text-center text-sm opacity-60">{ctx.t('emptySection')}</p>;
}

function Img({ src, className, alt = '' }: { src: string; className: string; alt?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
  return <img src={src} srcSet={imageSrcSet(src)} sizes="100vw" alt={alt} loading="lazy" className={className} />;
}

function Banner({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const { theme, t, base } = ctx;
  const image = ctx.image(str(s.settings, 'image') ?? theme.banner);
  const style = s.settings.style === 'auto' || !s.settings.style ? theme.layout.hero : s.settings.style;
  const title = str(s.settings, 'heading') ?? theme.headline ?? t(`templates.${theme.template}.headline`);
  const sub = str(s.settings, 'text') ?? theme.subheadline ?? t(`templates.${theme.template}.subheadline`);
  const label = str(s.settings, 'buttonLabel') ?? t('shopNow');
  const link = str(s.settings, 'buttonLink') ?? '/all';
  const text = (
    <>
      <h1 className="text-3xl font-semibold leading-tight @2xl:text-5xl" style={heading}>{title}</h1>
      {sub && <p className="max-w-xl text-base opacity-80 @2xl:text-lg">{sub}</p>}
    </>
  );
  if (style === 'full' && image) return (
    <section className="relative isolate overflow-hidden rounded-[var(--shop-radius)]">
      <Img src={image} className="absolute inset-0 -z-10 size-full object-cover" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
      <div className="flex min-h-[340px] flex-col justify-end gap-4 p-6 text-white @2xl:min-h-[460px] @2xl:p-10">{text}<div><Button link={link} base={base} label={label} /></div></div>
    </section>
  );
  if (style === 'split' && image) return (
    <section className="grid items-center gap-6 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-5 ring-1 ring-black/5 @2xl:p-8 @3xl:grid-cols-2">
      <div className="order-2 flex flex-col gap-4 @3xl:order-1">{text}<div><Button link={link} base={base} label={label} /></div></div>
      <Img src={image} className="order-1 aspect-[4/3] w-full rounded-[var(--shop-radius)] object-cover @3xl:order-2" />
    </section>
  );
  return (
    <section className="flex flex-col gap-4 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] p-6 text-[var(--shop-on-primary)] @2xl:p-10">
      {text}
      <div><Button link={link} base={base} label={label} tone="accent" /></div>
    </section>
  );
}

function Slideshow({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const slides = s.items.map((item) => ({ item, src: ctx.image(str(item, 'image')) })).filter((x) => x.src || str(x.item, 'heading'));
  if (!slides.length) return <Empty ctx={ctx} />;
  return (
    <section aria-roledescription="carousel" className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2">
      {slides.map(({ item, src }, i) => (
        <div key={i} role="group" aria-roledescription="slide" aria-label={`${i + 1} / ${slides.length}`}
          className="relative isolate flex min-h-[300px] w-[88%] shrink-0 snap-center flex-col justify-end gap-3 overflow-hidden rounded-[var(--shop-radius)] bg-[var(--shop-primary)] p-6 text-white @2xl:min-h-[420px] @2xl:w-full @2xl:p-10">
          {src && <Img src={src} className="absolute inset-0 -z-10 size-full object-cover" />}
          {src && <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/70 via-black/25 to-transparent" />}
          {str(item, 'heading') && <h2 className="text-2xl font-semibold @2xl:text-4xl" style={heading}>{str(item, 'heading')}</h2>}
          {str(item, 'text') && <p className="max-w-xl opacity-90">{str(item, 'text')}</p>}
          {str(item, 'buttonLabel') && <div><Button link={str(item, 'buttonLink') ?? '/all'} base={ctx.base} label={str(item, 'buttonLabel')!} tone="accent" /></div>}
        </div>
      ))}
    </section>
  );
}

function Categories({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  if (!ctx.categories.length) return <Empty ctx={ctx} />;
  const id = `shop-${s.id}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <Title id={id}>{str(s.settings, 'title') ?? ctx.t('categories')}</Title>
      {ctx.theme.layout.categories === 'tiles' ? (
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @5xl:grid-cols-4">
          {ctx.categories.map((c) => (
            <Link key={c.id} href={categoryPath(ctx.handle, c)}
              className="flex min-h-20 items-end rounded-[var(--shop-radius)] bg-[var(--shop-accent)] p-4 font-semibold text-[var(--shop-on-accent)] hover:opacity-90">
              {c.name}
            </Link>
          ))}
        </div>
      ) : (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {ctx.categories.map((c) => (
            <Link key={c.id} href={categoryPath(ctx.handle, c)}
              className="inline-flex h-11 shrink-0 items-center rounded-full border border-black/15 bg-[var(--shop-surface)] px-4 text-sm hover:border-black/40">
              {c.name}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function Products({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const collectionId = str(s.settings, 'collection');
  const collection = collectionId ? ctx.collections?.[collectionId] ?? null : null;
  // A collection that is gone or not published shows nothing, never the category behind it.
  const category = collectionId ? null : str(s.settings, 'category');
  const limit = typeof s.settings.limit === 'number' ? s.settings.limit : 4;
  const products = collectionId
    ? pickCollectionProducts(ctx.products, collection?.productIds ?? [], limit)
    : pickProducts(ctx.products, s.settings, categoryTree(ctx.tree));
  const categoryName = category ? ctx.tree.find((c) => c.id === category)?.name ?? ctx.categories.find((c) => c.id === category)?.name : null;
  const title = str(s.settings, 'title') ?? collection?.title ?? categoryName ?? ctx.t('featured');
  const viewAll = collection ? `${ctx.base}/collections/${collection.slug}` : category ? categoryPath(ctx.handle, ctx.tree.find((c) => c.id === category) ?? ctx.categories.find((c) => c.id === category) ?? { id: category }) : `${ctx.base}/all`;
  const id = `shop-${s.id}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <Title id={id}>{title}</Title>
        <Link href={viewAll} className="text-sm font-medium underline">{ctx.t('viewAll')}</Link>
      </div>
      {products.length === 0 ? <p className="opacity-70">{ctx.t('noProducts')}</p> : (
        <ProductGrid columns={ctx.theme.layout.columns}>
          {products.map((p) => <ProductCard key={p.id} handle={ctx.handle} product={p} currency={ctx.currency} layout={ctx.theme.layout}
            locale={ctx.locale} labels={cardLabels(ctx.t)} />)}
        </ProductGrid>
      )}
    </section>
  );
}

function ImageText({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const src = ctx.image(str(s.settings, 'image'));
  const title = str(s.settings, 'heading');
  const body = str(s.settings, 'text');
  if (!src && !title && !body) return <Empty ctx={ctx} />;
  const right = s.settings.imageSide === 'right';
  return (
    <section className="grid items-center gap-6 @3xl:grid-cols-2">
      {src && <Img src={src} className={`aspect-[4/3] w-full rounded-[var(--shop-radius)] object-cover ${right ? '@3xl:order-2' : ''}`} />}
      <div className="flex flex-col gap-3">
        {title && <Title>{title}</Title>}
        {body && <p className="whitespace-pre-line opacity-80">{body}</p>}
        {str(s.settings, 'buttonLabel') && <div><Button link={str(s.settings, 'buttonLink') ?? '/all'} base={ctx.base} label={str(s.settings, 'buttonLabel')!} /></div>}
      </div>
    </section>
  );
}

function Testimonials({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const items = s.items.filter((i) => str(i, 'quote'));
  if (!items.length) return <Empty ctx={ctx} />;
  return (
    <section className="flex flex-col gap-3">
      <Title>{str(s.settings, 'title') ?? ctx.t('testimonials')}</Title>
      <div className="grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {items.map((item, i) => (
          <figure key={i} className="flex flex-col gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-5 ring-1 ring-black/5">
            <blockquote className="whitespace-pre-line">“{str(item, 'quote')}”</blockquote>
            {str(item, 'name') && <figcaption className="text-sm font-semibold text-[var(--shop-primary)]">{str(item, 'name')}</figcaption>}
          </figure>
        ))}
      </div>
    </section>
  );
}

export function FaqList({ items }: { items: Array<{ question: string; answer: string }> }) {
  return (
    <div className="divide-y divide-black/10 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] ring-1 ring-black/5">
      {items.map((item, i) => (
        <details key={i} className="group p-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium">
            {item.question}<span aria-hidden className="transition group-open:rotate-45">+</span>
          </summary>
          <p className="mt-2 whitespace-pre-line opacity-80">{item.answer}</p>
        </details>
      ))}
    </div>
  );
}

function Faq({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const items = s.items.flatMap((i) => (str(i, 'question') && str(i, 'answer') ? [{ question: str(i, 'question')!, answer: str(i, 'answer')! }] : []));
  if (!items.length) return <Empty ctx={ctx} />;
  return (
    <section className="flex flex-col gap-3">
      <Title>{str(s.settings, 'title') ?? ctx.t('faqTitle')}</Title>
      <FaqList items={items} />
    </section>
  );
}

function Video({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const url = str(s.settings, 'video');
  if (!url) return <Empty ctx={ctx} />;
  const yt = youtubeId(url);
  return (
    <section className="flex flex-col gap-3">
      {str(s.settings, 'title') && <Title>{str(s.settings, 'title')}</Title>}
      {yt ? (
        // YouTube cannot be embedded (the app's CSP allows no outside frames): a poster that opens the video.
        <a href={`https://www.youtube.com/watch?v=${yt}`} target="_blank" rel="noopener noreferrer"
          className="relative block aspect-video overflow-hidden rounded-[var(--shop-radius)] bg-black" aria-label={ctx.t('playOnYouTube')}>
          <Img src={`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`} className="size-full object-cover opacity-90" />
          <span className="absolute inset-0 grid place-items-center">
            <span className="flex h-14 items-center gap-2 rounded-full bg-black/75 px-5 text-sm font-semibold text-white">
              <Play className="size-5" aria-hidden />{ctx.t('playOnYouTube')}
            </span>
          </span>
        </a>
      ) : (
        <video src={url} controls preload="metadata" playsInline className="aspect-video w-full rounded-[var(--shop-radius)] bg-black" />
      )}
      {str(s.settings, 'caption') && <p className="text-sm opacity-70">{str(s.settings, 'caption')}</p>}
    </section>
  );
}

function Text({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const title = str(s.settings, 'heading');
  const body = str(s.settings, 'text');
  if (!title && !body) return <Empty ctx={ctx} />;
  return (
    <section className={`mx-auto flex max-w-3xl flex-col gap-3 ${s.settings.align === 'center' ? 'items-center text-center' : ''}`}>
      {title && <Title>{title}</Title>}
      {body && <p className="whitespace-pre-line opacity-80">{body}</p>}
    </section>
  );
}

function Announcement({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const message = str(s.settings, 'text');
  if (!message) return <Empty ctx={ctx} />;
  return (
    <ShopLink link={str(s.settings, 'link')} base={ctx.base}
      className="block rounded-[var(--shop-radius)] bg-[var(--shop-accent)] px-4 py-3 text-center text-sm font-semibold text-[var(--shop-on-accent)]">
      {message}
    </ShopLink>
  );
}

function WhatsApp({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  if (!ctx.whatsappPhone) return <Empty ctx={ctx} />;
  const message = str(s.settings, 'message');
  const href = `https://wa.me/${ctx.whatsappPhone}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
  return (
    <section className="flex flex-col items-start gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-6 ring-1 ring-black/5 @2xl:flex-row @2xl:items-center @2xl:justify-between">
      <div>
        <Title>{str(s.settings, 'heading') ?? ctx.t('whatsappHeading')}</Title>
        <p className="mt-1 opacity-80">{str(s.settings, 'text') ?? ctx.t('whatsappText')}</p>
      </div>
      <a href={href} target="_blank" rel="noopener noreferrer"
        className="inline-flex h-12 shrink-0 items-center rounded-[var(--shop-radius)] bg-[#25d366] px-6 font-semibold text-black">
        {str(s.settings, 'buttonLabel') ?? ctx.t('chatOnWhatsApp')}
      </a>
    </section>
  );
}

/** Whether an ISO moment has passed (kept out of render bodies). */
const isPast = (iso: string) => Date.parse(iso) <= Date.now();

function Offer({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const endsAt = str(s.settings, 'endsAt');
  const title = str(s.settings, 'heading');
  if (!endsAt || !title) return <Empty ctx={ctx} />;
  if (isPast(endsAt)) return ctx.preview ? <p className="rounded-[var(--shop-radius)] border border-dashed border-black/20 p-6 text-center text-sm opacity-70">{ctx.t('offer.ended')}</p> : null;
  const label = str(s.settings, 'buttonLabel');
  return (
    <OfferCountdown endsAt={endsAt} className="flex flex-col items-start rounded-[var(--shop-radius)] bg-[var(--shop-primary)] p-6 text-[var(--shop-on-primary)] @2xl:p-10"
      labels={{ endsIn: ctx.t('offer.endsIn'), days: ctx.t('offer.days'), hours: ctx.t('offer.hours'), minutes: ctx.t('offer.minutes'), seconds: ctx.t('offer.seconds') }}
      after={label ? <div className="mt-5"><Button link={str(s.settings, 'buttonLink') ?? '/all'} base={ctx.base} label={label} tone="accent" /></div> : null}>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-90">{ctx.t('offer.endsIn')}</p>
      <h2 className="mt-1 text-2xl font-semibold @2xl:text-4xl" style={heading}>{title}</h2>
      {str(s.settings, 'text') && <p className="mt-2 max-w-xl opacity-90">{str(s.settings, 'text')}</p>}
    </OfferCountdown>
  );
}

const TRUST_ICON: Record<TrustIcon, LucideIcon> = {
  truck: Truck, shield: ShieldCheck, returns: RotateCcw, cash: Banknote, leaf: Leaf, star: Star, support: Headset, badge: BadgeCheck,
};

function TrustBadges({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const items = s.items.filter((i) => str(i, 'text'));
  if (!items.length) return <Empty ctx={ctx} />;
  const title = str(s.settings, 'title');
  return (
    <section className="flex flex-col gap-3">
      {title && <Title>{title}</Title>}
      <ul className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {items.map((item, i) => {
          const Icon = TRUST_ICON[item.icon as TrustIcon] ?? Truck;
          return (
            <li key={i} className="flex items-center gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-4 ring-1 ring-black/5">
              <Icon className="size-6 shrink-0 text-[var(--shop-primary)]" aria-hidden />
              <span className="text-sm font-medium">{str(item, 'text')}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LogoStrip({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const logos = s.items.flatMap((item) => { const src = ctx.image(str(item, 'image')); return src ? [{ src, name: str(item, 'name') ?? '' }] : []; });
  if (!logos.length) return <Empty ctx={ctx} />;
  const title = str(s.settings, 'title');
  return (
    <section className="flex flex-col items-center gap-4">
      {title && <Title>{title}</Title>}
      <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
        {logos.map((logo, i) => <li key={i}><Img src={logo.src} alt={logo.name} className="h-10 w-auto max-w-[140px] object-contain opacity-80 @2xl:h-12" /></li>)}
      </ul>
    </section>
  );
}

function Gallery({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const pictures = s.items.flatMap((item) => { const src = ctx.image(str(item, 'image')); return src ? [{ src, link: str(item, 'link') }] : []; });
  if (!pictures.length) return <Empty ctx={ctx} />;
  const title = str(s.settings, 'title');
  return (
    <section className="flex flex-col gap-3">
      {title && <Title>{title}</Title>}
      <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-3 @5xl:grid-cols-4">
        {pictures.map((pic, i) => {
          const img = <Img src={pic.src} className="aspect-square w-full rounded-[var(--shop-radius)] object-cover" />;
          return pic.link ? <ShopLink key={i} link={pic.link} base={ctx.base} className="block">{img}</ShopLink> : <div key={i}>{img}</div>;
        })}
      </div>
    </section>
  );
}

function SignUp({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  // No anonymous subscriber list exists, so sign-up opens the shop's WhatsApp chat with "Subscribe" typed in; the buyer sends it.
  if (!ctx.whatsappPhone) return <Empty ctx={ctx} />;
  const href = `https://wa.me/${ctx.whatsappPhone}?text=${encodeURIComponent(ctx.t('signup.message'))}`;
  return (
    <section className="flex flex-col items-center gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-6 text-center ring-1 ring-black/5 @2xl:p-10">
      <Title>{str(s.settings, 'heading') ?? ctx.t('signup.heading')}</Title>
      <p className="max-w-xl opacity-80">{str(s.settings, 'text') ?? ctx.t('signup.text')}</p>
      <a href={href} target="_blank" rel="noopener noreferrer"
        className="inline-flex h-12 items-center gap-2 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-6 font-semibold text-[var(--shop-on-primary)]">
        <MessageCircle className="size-5" aria-hidden />{str(s.settings, 'buttonLabel') ?? ctx.t('signup.button')}
      </a>
      <p className="text-xs opacity-70">{ctx.t('signup.note')}</p>
    </section>
  );
}

function BestSellers({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const limit = typeof s.settings.limit === 'number' ? s.settings.limit : 4;
  // The editor's preview has no sales to rank, so it shows the first products as stand-ins.
  const products = (ctx.preview ? ctx.products : ctx.bestSellers ?? []).slice(0, limit);
  if (!products.length) return ctx.preview ? <Empty ctx={ctx} /> : null;
  const id = `shop-${s.id}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <Title id={id}>{str(s.settings, 'title') ?? ctx.t('bestSellers')}</Title>
      <ProductGrid columns={ctx.theme.layout.columns}>
        {products.map((p) => <ProductCard key={p.id} handle={ctx.handle} product={p} currency={ctx.currency} layout={ctx.theme.layout} locale={ctx.locale} labels={cardLabels(ctx.t)} />)}
      </ProductGrid>
    </section>
  );
}

function Recent({ s, ctx }: { s: ShopSection; ctx: SectionContext }) {
  const labels = cardLabels(ctx.t);
  return (
    <RecentlyViewed handle={ctx.handle} limit={typeof s.settings.limit === 'number' ? s.settings.limit : 4} layout={ctx.theme.layout}
      currency={ctx.currency} locale={ctx.locale} preview={ctx.preview} sample={ctx.preview ? ctx.products : []}
      title={<Title>{str(s.settings, 'title') ?? ctx.t('recentlyViewed')}</Title>}
      labels={{ soldOut: labels.soldOut, from: labels.from, add: labels.add, added: labels.added, sale: ctx.t('card.sale', { percent: '{percent}' }) }} />
  );
}

const RENDERERS: Record<ShopSection['type'], (props: { s: ShopSection; ctx: SectionContext }) => ReactNode> = {
  announcement: Announcement, banner: Banner, slideshow: Slideshow, categories: Categories, featured_collection: Products,
  product_grid: Products, image_text: ImageText, testimonials: Testimonials, faq: Faq, video: Video, text: Text, whatsapp: WhatsApp,
  offer: Offer, trust_badges: TrustBadges, logo_strip: LogoStrip, gallery: Gallery, signup: SignUp, best_sellers: BestSellers, recently_viewed: Recent,
};

export function ShopSectionsView({ sections, ctx, selected }: { sections: ShopSection[]; ctx: SectionContext; selected?: string | null }) {
  return (
    <div className="flex flex-col gap-8 @2xl:gap-12">
      {sections.filter((s) => !s.hidden).map((s) => {
        const Render = RENDERERS[s.type];
        return (
          <div key={s.id} data-section={s.id}
            className={ctx.preview && selected === s.id ? 'rounded-[var(--shop-radius)] outline outline-2 outline-offset-4 outline-sky-500' : undefined}>
            <Render s={s} ctx={ctx} />
          </div>
        );
      })}
    </div>
  );
}
