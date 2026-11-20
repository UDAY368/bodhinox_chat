// Streams one image for the public shop: an https URL is redirected to; a media library object of the shop's workspace is streamed
// with a strict content type, nosniff and a sandbox CSP. Anything else is the plain 404.
//
// Store Batch 6: the address of an image never changes what it shows (product image rows and media ids are fixed), so the answer is
// cached for a year (immutable). `width` (320, 640 or 1080) answers a WebP copy of that width, made once with sharp and kept in the
// workspace's storage under a derived key (never in the media library), then read from storage. The storage is private (S3 signed
// links last minutes, not a year), so the bytes are streamed rather than redirected to.

import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import type { ShopImageWidth } from '@/lib/commerce/shop-images';
import { getMedia, putMedia } from '@/lib/storage/server';
import { notFound } from '../../shop/_lib/public';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
const IMAGE_TYPE = /^image\/(png|jpeg|webp|gif)$/;
const VARIANT_BUCKET = 'chat-media';

/** Where the WebP copy of one media object at one width is kept (inside the workspace's own prefix). */
export const variantKey = (accountId: string, mediaId: string, width: ShopImageWidth): string =>
  `account-${accountId}/shop-images/${mediaId.toLowerCase()}-w${width}.webp`;

const imageHeaders = (contentType: string) => ({
  'Content-Type': contentType, 'Cache-Control': IMMUTABLE, 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
});

type MediaRow = { bucket: string; object_key: string; content_type: string | null };

async function findMedia(accountId: string, by: { id: string } | { bucket: string; key: string }): Promise<MediaRow | null> {
  const id = 'id' in by ? by.id : null, bucket = 'bucket' in by ? by.bucket : null, key = 'key' in by ? by.key : null;
  const [row] = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<MediaRow[]>`
    SELECT bucket, object_key, content_type FROM media_objects
    WHERE account_id=${accountId}::uuid AND deleted_at IS NULL AND (${id}::uuid IS NULL OR id=${id}::uuid)
      AND (${bucket}::text IS NULL OR (bucket=${bucket} AND object_key=${key}))`, getWorkerPrisma());
  return row ?? null;
}

async function streamObject(accountId: string, media: MediaRow): Promise<Response> {
  const { object, contentType } = await getMedia({ accountId, role: 'owner' }, media.bucket, media.object_key);
  if (!object.Body || !IMAGE_TYPE.test(contentType)) return notFound();
  return new Response(object.Body.transformToWebStream() as ReadableStream<Uint8Array>, { headers: imageHeaders(contentType) });
}

/** The WebP copy at `width`: from storage when made before, else made now from the original, stored, and answered. */
async function streamVariant(accountId: string, mediaId: string, original: MediaRow, width: ShopImageWidth): Promise<Response> {
  const key = variantKey(accountId, mediaId, width);
  const made = await findMedia(accountId, { bucket: VARIANT_BUCKET, key });
  if (made) return streamObject(accountId, made);
  const { object } = await getMedia({ accountId, role: 'owner' }, original.bucket, original.object_key);
  if (!object.Body) return notFound();
  const source = await object.Body.transformToByteArray();
  const sharp = (await import('sharp')).default;
  const webp = new Uint8Array(await sharp(source, { limitInputPixels: 40_000_000 }).rotate()
    .resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer());
  try {
    // worker: the system stores it (never refused for the plan's storage); not in the library, so the seller never sees it there.
    await putMedia({ accountId, role: 'owner' }, VARIANT_BUCKET, key, webp, 'image/webp', false, true);
  } catch (error) {
    // Another request made the same copy first, or storage refused: this answer still has its bytes.
    console.warn('[store:image] variant not stored', error instanceof Error ? error.name : 'error');
  }
  return new Response(webp, { headers: imageHeaders('image/webp') });
}

export async function streamShopMedia(accountId: string, url: string | null, mediaId: string | null, width: ShopImageWidth | null = null): Promise<Response> {
  if (url) {
    if (!/^https:\/\//.test(url)) return notFound();
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': IMMUTABLE, 'Referrer-Policy': 'no-referrer' } });
  }
  if (!mediaId) return notFound();
  const media = await findMedia(accountId, { id: mediaId });
  if (!media || !IMAGE_TYPE.test(media.content_type ?? '')) return notFound();
  // A GIF may move: it is always the original.
  if (width && media.content_type !== 'image/gif') return streamVariant(accountId, mediaId, media, width);
  return streamObject(accountId, media);
}
