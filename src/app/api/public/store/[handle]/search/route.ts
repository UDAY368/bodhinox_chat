// GET /api/public/store/<handle>/search?q=  -> { suggestions: [{ id, name, category }] } (at most 8; [] for a query under 2 characters)
// The shop's search suggestions. Only products a visitor can buy right now (published, inside their publish dates); a shop that is
// not open to the visitor answers the plain 404. The query is never logged.

import { burstAllowed, json, notFound, publicError, tooMany } from '../../../shop/_lib/public';
import { isShopHandleFormat } from '@/lib/commerce/public-shop';
import { searchSuggestions } from '@/lib/commerce/shop-search';
import type { HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: HandleParams) {
  try {
    if (!(await burstAllowed('read', request))) return tooMany();
    const { handle } = await params;
    if (!isShopHandleFormat(handle)) return notFound();
    const suggestions = await searchSuggestions(handle, new URL(request.url).searchParams.get('q'));
    return suggestions === null ? notFound() : json({ suggestions });
  } catch (error) {
    return publicError(error, 'store:search');
  }
}
