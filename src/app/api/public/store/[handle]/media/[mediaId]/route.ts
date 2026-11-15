// GET /api/public/store/<handle>/media/<mediaId>  an image of the shop from
// the media library: logo, banner, a section's image or the About page image.
// Only an id the published theme or published content names is served (never
// the draft's), so no other library file becomes public.

import { isUuid } from '@/lib/commerce/store-settings';
import { isShopHandleFormat, withPublicShop } from '@/lib/commerce/public-shop';
import { readThemeSettings } from '@/lib/commerce/shop-templates';
import { contentMediaIds, readShopContent } from '@/lib/commerce/shop-sections';
import { streamShopMedia } from '../../../_lib/media';
import { burstAllowed, notFound, publicError, tooMany } from '../../../../shop/_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ handle: string; mediaId: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!burstAllowed('read', request)) return tooMany();
  try {
    const { handle, mediaId } = await params;
    if (!isShopHandleFormat(handle) || !isUuid(mediaId)) return notFound();
    const accountId = await withPublicShop(handle, async (tx, account) => {
      const [row] = await tx.$queryRaw<{ theme: unknown; document: unknown }[]>`SELECT theme, document FROM shop_storefronts
        WHERE account_id=${account}::uuid`;
      const ids = contentMediaIds(readThemeSettings(row?.theme), readShopContent(row?.document));
      return ids.includes(mediaId.toLowerCase()) ? account : null;
    });
    if (!accountId) return notFound();
    return streamShopMedia(accountId, null, mediaId.toLowerCase());
  } catch (error) {
    return publicError(error, 'store:media');
  }
}
