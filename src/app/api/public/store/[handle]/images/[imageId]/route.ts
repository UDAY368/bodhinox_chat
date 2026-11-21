// GET /api/public/store/<handle>/images/<imageId>[?w=320|640|1080]  one image of a published
// product of a published shop. Library media is streamed (?w: a stored WebP copy of that width);
// an https image URL is redirected to. Public and cached for a year: an image id always shows the same picture.

import { isUuid } from '@/lib/commerce/store-settings';
import { withPublicShop, isShopHandleFormat } from '@/lib/commerce/public-shop';
import { readImageWidth } from '@/lib/commerce/shop-images';
import { streamShopMedia } from '../../../_lib/media';
import { burstAllowed, notFound, publicError, tooMany } from '../../../../shop/_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ handle: string; imageId: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!(await burstAllowed('image', request))) return tooMany();
  try {
    const { handle, imageId } = await params;
    if (!isShopHandleFormat(handle) || !isUuid(imageId)) return notFound();
    const found = await withPublicShop(handle, async (tx, accountId) => {
      const [row] = await tx.$queryRaw<{ url: string | null; media_id: string | null }[]>`
        SELECT i.url, i.media_id::text AS media_id FROM shop_product_images i
        JOIN shop_products p ON p.account_id=i.account_id AND p.id=i.product_id AND shop_product_live(p.status, p.publish_at, p.hide_at)
        WHERE i.account_id=${accountId}::uuid AND i.id=${imageId}::uuid`;
      return row ? { accountId, ...row } : null;
    });
    if (!found) return notFound();
    return streamShopMedia(found.accountId, found.url, found.media_id, readImageWidth(new URL(request.url).searchParams.get('w')));
  } catch (error) {
    return publicError(error, 'store:image');
  }
}
