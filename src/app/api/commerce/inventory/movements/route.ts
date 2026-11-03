// GET /api/commerce/inventory/movements?variant_id=&before=&limit= — the stock ledger, newest first (agents and above).
//   200 { movements, next }; pass `next` back as `before` for the following page.
export const runtime = 'nodejs';

import { listMovements, parseMovementQuery } from '@/lib/commerce/catalogue/inventory';
import { catalogueErrorResponse, inTenant, json, staffCaller } from '../../shop/_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    const query = parseMovementQuery(new URL(request.url).searchParams);
    return json(await inTenant(caller, (tx) => listMovements(tx, caller.accountId, query)));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
