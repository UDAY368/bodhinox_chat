import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ShopT } from '@/components/shop-public/shop-link';
import { ShopPageView } from '@/components/shop-public/shop-page';
import { loadShopPage, themeImageUrl } from '@/lib/commerce/public-shop';
import { isPageSlug, pagesOn } from '@/lib/commerce/shop-sections';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!isPageSlug(slug)) return { robots: { index: false, follow: false } };
  return { title: (await getTranslations('ShopPublic'))(`pages.${slug}`) };
}

export default async function ShopStorePage({ params }: Props) {
  const { handle, slug } = await params;
  if (!isPageSlug(slug)) notFound();
  const data = await loadShopPage(handle);
  if (!data) notFound();
  const on = pagesOn(data.content);
  // About, Contact and FAQ exist only when the shop wrote them; the policy pages always exist.
  if ((slug === 'about' || slug === 'contact' || slug === 'faq') && !on[slug]) notFound();
  const t = await getTranslations('ShopPublic');
  const content = { ...data.content, pages: { ...data.content.pages, about: { ...data.content.pages.about, image: themeImageUrl(handle, data.content.pages.about.image) } } };
  return <ShopPageView slug={slug} content={content} facts={data.facts} shopName={data.shop.name} t={t as unknown as ShopT}
    locale={await getLocale()} contactDetails={!!(content.footer.contact.phone || content.footer.contact.email || content.footer.contact.address || content.footer.contact.hours)} />;
}
