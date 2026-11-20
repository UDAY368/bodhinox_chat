// GET  /api/commerce/stock-transfers — the latest transfers, newest first (agents and above). 200 { transfers }.
// POST /api/commerce/stock-transfers { client_key, from_location_id, to_location_id, variant_id, quantity, note? }
//   Move units between two locations. Admins with commerce.inventory; worker role; audited. The sellable total does not change.
//   200 { transferId, replayed } (a repeated client_key changes nothing); 409 insufficient_stock, location_inactive, key_reused.
export const runtime = 'nodejs';

import { listTransfers, parseTransferInput, transferStock } from '@/lib/commerce/stock-locations';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../shop/_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    return json({ transfers: await inTenant(caller, (tx) => listTransfers(tx, caller.accountId)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = await mutationLimit(caller);
    if (limited) return limited;
    return json(await transferStock(caller.tenant, parseTransferInput(await readJson(request))));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
