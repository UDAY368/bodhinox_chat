/**
 * The one place a shop image address is built (store Batch 6). Pure functions, safe in client components.
 *
 * - A product image: /api/public/store/<handle>/images/<image id>. An image row never changes (rows are only added and removed), so
 *   the address is fixed for that picture and the route answers it with a one-year immutable cache.
 * - A theme or content image from the media library: /api/public/store/<handle>/media/<media id>; a stored https URL is used as is.
 * - Our own addresses also come in fixed widths (?w=320|640|1080, WebP), made once and kept in storage; `imageSrcSet` lists them for
 *   <img srcset>. An https URL of the seller's own is never resized.
 */
import { mediaIdOf, type ShopImageRef } from './shop-templates';

/** The widths the image routes make (WebP); any other ?w is the original. */
export const SHOP_IMAGE_WIDTHS = [320, 640, 1080] as const;
export type ShopImageWidth = (typeof SHOP_IMAGE_WIDTHS)[number];

export const isShopImageWidth = (value: unknown): value is ShopImageWidth =>
  typeof value === 'number' && (SHOP_IMAGE_WIDTHS as readonly number[]).includes(value);

/** ?w= as a known width, or null (the original). */
export function readImageWidth(value: string | null): ShopImageWidth | null {
  if (!value || !/^[1-9]\d{2,3}$/.test(value)) return null;
  const width = Number(value);
  return isShopImageWidth(width) ? width : null;
}

/** A product image of the public shop. */
export const shopImageUrl = (handle: string, imageId: string): string => `/api/public/store/${handle}/images/${imageId}`;

/** A theme or content image of the public shop: a library media id goes through our route, an https URL stays as it is. */
export function themeImageUrl(handle: string, ref: ShopImageRef | null): string | null {
  if (!ref) return null;
  const mediaId = mediaIdOf(ref);
  return mediaId ? `/api/public/store/${handle}/media/${mediaId}` : ref;
}

const OUR_IMAGE = /^\/api\/public\/store\/[a-z0-9-]+\/(images|media)\/[0-9a-f-]{36}$/;

/** "<url>?w=320 320w, …" for one of our own image addresses; undefined for anything else (an https URL, a signed-in preview URL). */
export function imageSrcSet(url: string | null | undefined): string | undefined {
  if (!url || !OUR_IMAGE.test(url)) return undefined;
  return SHOP_IMAGE_WIDTHS.map((w) => `${url}?w=${w} ${w}w`).join(', ');
}

/** `sizes` for a product card in the shop's grid (two a row on phones, up to four on wide screens). */
export const CARD_IMAGE_SIZES = '(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw';
