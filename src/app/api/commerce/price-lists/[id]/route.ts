// PATCH  /api/commerce/price-lists/<id> — replace one (admins). The body carries expected_version:
//   200 { price_list }; 404 not_found; 409 conflict when someone else changed it first.
// DELETE /api/commerce/price-lists/<id> — remove one (admins). 200 { ok: true }; 404 not_found.

import { deletePriceList, parsePriceList, updatePriceList } from '@/lib/commerce/price-rules-store';
import { itemHandlers } from '@/lib/commerce/rule-http';

const handlers = itemHandlers('price-lists', 'price_list', { parse: parsePriceList, update: updatePriceList, remove: deletePriceList });

export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
