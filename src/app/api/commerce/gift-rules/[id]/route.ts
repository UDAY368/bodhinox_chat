// PATCH  /api/commerce/gift-rules/<id> — replace one (admins). The body carries expected_version:
//   200 { gift_rule }; 404 not_found; 409 conflict when someone else changed it first.
// DELETE /api/commerce/gift-rules/<id> — remove one (admins). 200 { ok: true }; 404 not_found.

import { deleteGiftRule, parseGiftRule, updateGiftRule } from '@/lib/commerce/price-rules-store';
import { itemHandlers } from '@/lib/commerce/rule-http';

const handlers = itemHandlers('gift-rules', 'gift_rule', { parse: parseGiftRule, update: updateGiftRule, remove: deleteGiftRule });

export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
