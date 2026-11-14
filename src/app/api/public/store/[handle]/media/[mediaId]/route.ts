// GET /api/public/store/<handle>/media/<mediaId>  the shop's logo or banner
// from the media library. Only an id the published theme names is served,
// so no other library file becomes public.

import { isUuid } from '@/lib/commerce/store-settings';
import { isShopHandleFormat, withPublicShop } from '@/lib/commerce/public-shop';
import { mediaIdOf, readThemeSettings } from '@/lib/commerce/shop-templates';
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
      const [row] = await tx.$queryRaw<{ theme: unknown }[]>`SELECT theme FROM shop_storefronts WHERE account_id=${account}::uuid`;
      const theme = readThemeSettings(row?.theme);
      return [mediaIdOf(theme.logo), mediaIdOf(theme.banner)].includes(mediaId.toLowerCase()) ? account : null;
    });
    if (!accountId) return notFound();
    return streamShopMedia(accountId, null, mediaId.toLowerCase());
  } catch (error) {
    return publicError(error, 'store:media');
  }
}
