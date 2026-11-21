/**
 * Search-engine facts for the public shop (store Batch 6): absolute addresses, the product listing text and schema.org JSON-LD.
 * Pure apart from shopOrigin(); nothing here reads the database.
 */
import { appOrigin } from '@/lib/auth/csrf';
import { minorToDecimalString } from './money';
import type { PublicProduct } from './public-shop';
import { categoryPath, productPath } from './shop-paths';

/**
 * The origin absolute shop URLs start with, or undefined when it is not configured. The one place the shop's SEO code asks for it:
 * when the root layout gets a metadataBase (publicBaseUrl() from src/lib/public-base-url.ts), swap the body for that.
 */
export function shopOrigin(): string | undefined {
  try { return appOrigin(); } catch { return undefined; }
}

/** A site path ("/s/...") made absolute when the origin is known, else left relative; a full https URL is kept (Next resolves it against metadataBase when there is one). */
export const absoluteUrl = (path: string, origin = shopOrigin()): string => (origin && path.startsWith('/') ? `${origin}${path}` : path);

/** Text cut to `max` characters on a word boundary, with an ellipsis; whitespace folded. */
export function clip(text: string | null | undefined, max: number): string | undefined {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface ProductSeoInput {
  handle: string;
  shopName: string;
  currency: string | null;
  product: PublicProduct;
  seo: { title: string | null; description: string | null; imageUrl: string | null; sku: string | null };
}

/** Title, description and share image a product page announces: the seller's listing, else the name, description and first image. */
export function productListing({ product, seo }: ProductSeoInput): { title: string; description: string | undefined; image: string | undefined } {
  return {
    title: seo.title ?? product.name,
    description: seo.description ?? clip(product.description, 160),
    image: seo.imageUrl ?? product.images[0],
  };
}

/** schema.org Product with its offer (or price range), availability, SKU and rating, plus the page's BreadcrumbList. */
export function productJsonLd(input: ProductSeoInput, origin = shopOrigin()): object[] {
  const { handle, product, currency, seo, shopName } = input;
  const url = absoluteUrl(productPath(handle, product), origin);
  const listing = productListing(input);
  const prices = product.variants.map((v) => v.priceMinor);
  const low = Math.min(...prices), high = Math.max(...prices);
  const inStock = product.variants.some((v) => v.inStock);
  const preorder = inStock && product.variants.every((v) => !v.inStock || v.shipsBy);
  const availability = `https://schema.org/${!inStock ? 'OutOfStock' : preorder ? 'PreOrder' : 'InStock'}`;
  const money = (minor: number) => (currency ? minorToDecimalString(minor, currency) : undefined);
  const offers = !currency || !prices.length ? undefined : low === high
    ? { '@type': 'Offer', url, price: money(low), priceCurrency: currency, availability }
    : { '@type': 'AggregateOffer', url, lowPrice: money(low), highPrice: money(high), priceCurrency: currency, availability, offerCount: product.variants.length };
  const images = [...new Set([listing.image, ...product.images].filter((i): i is string => !!i))].slice(0, 10).map((i) => absoluteUrl(i, origin));
  const productLd: Record<string, unknown> = {
    '@context': 'https://schema.org', '@type': 'Product', name: product.name, url,
    ...(listing.description ? { description: listing.description } : {}),
    ...(images.length ? { image: images } : {}),
    ...(seo.sku ? { sku: seo.sku } : {}),
    ...(offers ? { offers } : {}),
    ...(product.rating && product.rating.count > 0
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: product.rating.average, reviewCount: product.rating.count, bestRating: 5, worstRating: 1 } }
      : {}),
  };
  const crumbs = [
    { name: shopName, url: absoluteUrl(`/s/${handle}`, origin) },
    ...(product.categoryId && product.categoryName
      ? [{ name: product.categoryName, url: absoluteUrl(categoryPath(handle, { id: product.categoryId, slug: product.categorySlug }), origin) }] : []),
    { name: product.name, url },
  ];
  const breadcrumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })),
  };
  return [productLd, breadcrumbLd];
}
