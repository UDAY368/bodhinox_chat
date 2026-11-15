// POST /api/commerce/shop/platform-import/[id]/cancel (admins) — stop a queued or running import after the page it is on. 200 { ok: true }.
//   404 for an import that is finished or belongs to another workspace.
export const runtime = 'nodejs';

import { cancelPlatformImport } from '@/lib/commerce/catalogue/platform-import-job';
import { CatalogueError, isId } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, json, mutationLimit, staffCaller, type IdContext } from '../../../_lib/http';

export async function POST(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    if (!isId(id) || !(await cancelPlatformImport({ ...caller.tenant, userId: caller.userId }, id))) throw new CatalogueError('not_found');
    return json({ ok: true });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
