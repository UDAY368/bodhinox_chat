// GET /api/public/store/<handle>/images/<imageId>  one image of a published
// product of a published shop. Library media is streamed; an https image URL
// is redirected to. Public and briefly cacheable (the product is public).

import { isUuid } from '@/lib/commerce/store-settings';
import { withPublicShop, isShopHandleFormat } from '@/lib/commerce/public-shop';
import { streamShopMedia } from '../../../_lib/media';
import { burstAllowed, notFound, publicError, tooMany } from '../../../../shop/_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ handle: string; imageId: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!(await burstAllowed('read', request))) return tooMany();
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
    return streamShopMedia(found.accountId, found.url, found.media_id);
  } catch (error) {
    return publicError(error, 'store:image');
  }
}
