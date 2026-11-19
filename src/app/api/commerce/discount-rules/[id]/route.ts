// PATCH  /api/commerce/discount-rules/<id> — replace one (admins). The body carries expected_version:
//   200 { discount_rule }; 404 not_found; 409 conflict when someone else changed it first.
// DELETE /api/commerce/discount-rules/<id> — remove one (admins). 200 { ok: true }; 404 not_found.

import { deleteDiscountRule, parseDiscountRule, updateDiscountRule } from '@/lib/commerce/price-rules-store';
import { itemHandlers } from '@/lib/commerce/rule-http';

const handlers = itemHandlers('discount-rules', 'discount_rule', { parse: parseDiscountRule, update: updateDiscountRule, remove: deleteDiscountRule });

export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
