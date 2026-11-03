// PUT /api/commerce/inventory/[variantId]/threshold { low_stock_threshold: 0..100000 | null }
//   Admins with commerce.inventory. null returns the variant to the store default. Audited; written through
//   lib/commerce/stock.ts on the worker role. 200 { ok: true }. 409 not_tracked; 404 another workspace's or unknown variant.
export const runtime = 'nodejs';

import { parseThresholdInput, setLowStockThreshold } from '@/lib/commerce/catalogue/inventory';
import { catalogueErrorResponse, json, mutationLimit, readJson, staffCaller } from '../../../shop/_lib/http';

type Context = { params: Promise<{ variantId: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const { variantId } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    await setLowStockThreshold(caller.tenant, parseThresholdInput(variantId, await readJson(request)));
    return json({ ok: true });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
