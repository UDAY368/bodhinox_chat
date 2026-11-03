// POST /api/commerce/inventory/[variantId]/adjust { kind: adjustment|receipt|write_off, delta, expected_on_hand, reason? }
//   Admins with commerce.inventory. Audited; written through lib/commerce/stock.ts on the worker role.
//   200 { level: { variantId, onHand, reserved } }. 409 stock_changed (the count moved since it was read: reload, so a
//   retried request never adjusts twice), below_reserved, not_tracked. A write-off needs a reason.
export const runtime = 'nodejs';

import { adjustStock, parseAdjustInput } from '@/lib/commerce/catalogue/inventory';
import { catalogueErrorResponse, json, mutationLimit, readJson, staffCaller } from '../../../shop/_lib/http';

type Context = { params: Promise<{ variantId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { variantId } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const input = parseAdjustInput(variantId, await readJson(request));
    return json({ level: await adjustStock(caller.tenant, input) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
