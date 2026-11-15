// Streams one image for the public shop: an https URL is redirected to; a
// media library object of the shop's workspace is streamed with a strict
// content type, nosniff and a sandbox CSP. Anything else is the plain 404.

import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { getMedia } from '@/lib/storage/server';
import { notFound } from '../../shop/_lib/public';

const CACHE = 'public, max-age=300, stale-while-revalidate=600';

export async function streamShopMedia(accountId: string, url: string | null, mediaId: string | null): Promise<Response> {
  if (url) {
    if (!/^https:\/\//.test(url)) return notFound();
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': CACHE, 'Referrer-Policy': 'no-referrer' } });
  }
  if (!mediaId) return notFound();
  const [media] = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ bucket: string; object_key: string; content_type: string | null }[]>`
    SELECT bucket, object_key, content_type FROM media_objects
    WHERE account_id=${accountId}::uuid AND id=${mediaId}::uuid AND deleted_at IS NULL`, getWorkerPrisma());
  if (!media || !/^image\/(png|jpeg|webp|gif)$/.test(media.content_type ?? '')) return notFound();
  const { object, contentType } = await getMedia({ accountId, role: 'owner' }, media.bucket, media.object_key);
  if (!object.Body) return notFound();
  return new Response(object.Body.transformToWebStream() as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': contentType, 'Cache-Control': CACHE, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
    },
  });
}
