// GET /api/public/shop/<token>/images/<imageId>  one image of a published
// product of the token's workspace. Library media is streamed (it is
// session-gated elsewhere); an https image URL is redirected to.

import { isStorefrontTokenFormat } from '@/lib/commerce/storefront-token';
import { isUuid } from '@/lib/commerce/store-settings';
import { getMedia } from '@/lib/storage/server';
import { burstAllowed, inPublicTenant, notFound, publicError, resolveToken, tooMany } from '../../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ token: string; imageId: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!burstAllowed('read', request)) return tooMany();
  try {
    const { token, imageId } = await params;
    if (!isStorefrontTokenFormat(token) || !isUuid(imageId)) return notFound();
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    const image = await inPublicTenant(ref.accountId, async (tx) => {
      const rows = await tx.$queryRaw<{ url: string | null; bucket: string | null; object_key: string | null; content_type: string | null }[]>`
        SELECT i.url, m.bucket, m.object_key, m.content_type FROM shop_product_images i
        JOIN shop_products p ON p.account_id=i.account_id AND p.id=i.product_id AND p.status='published'
        LEFT JOIN media_objects m ON m.account_id=i.account_id AND m.id=i.media_id AND m.deleted_at IS NULL
        WHERE i.account_id=${ref.accountId}::uuid AND i.id=${imageId}::uuid`;
      return rows[0] ?? null;
    });
    if (!image) return notFound();
    if (image.url) {
      if (!/^https:\/\//.test(image.url)) return notFound();
      return new Response(null, { status: 302, headers: { Location: image.url, 'Cache-Control': 'private, max-age=300', 'Referrer-Policy': 'no-referrer' } });
    }
    if (!image.bucket || !image.object_key || !/^image\/(png|jpeg|webp|gif)$/.test(image.content_type ?? '')) return notFound();
    const { object, contentType } = await getMedia({ accountId: ref.accountId, role: 'owner' }, image.bucket, image.object_key);
    if (!object.Body) return notFound();
    return new Response(object.Body.transformToWebStream() as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': contentType, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    return publicError(error, 'image');
  }
}
