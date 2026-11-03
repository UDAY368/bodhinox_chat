// POST /api/commerce/shop/products/[id]/archive { archived: boolean } — archive (off the storefront and new orders;
//   existing orders keep their snapshots) or restore to draft (admins). 200 { product }.
export const runtime = 'nodejs';

import { archiveProduct, CatalogueError } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../../_lib/http';

export async function POST(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = (await readJson(request)) as { archived?: unknown } | null;
    if (typeof body?.archived !== 'boolean') throw new CatalogueError('invalid', 'archived');
    const archived = body.archived;
    return json({ product: await inTenant(caller, (tx) => archiveProduct(tx, caller.accountId, caller.userId, id, archived)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
