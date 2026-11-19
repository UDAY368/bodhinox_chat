// GET  /api/commerce/discount-rules — the discount rules per product, category or customer group of the workspace (agents and above).
// POST /api/commerce/discount-rules — create one (admins). 201 { discount_rule }; 409 price_rule_limit (50 rules).

import { createDiscountRule, listDiscountRules, parseDiscountRule } from '@/lib/commerce/price-rules-store';
import { collectionHandlers } from '@/lib/commerce/rule-http';

const handlers = collectionHandlers('discount-rules', 'discount_rules', 'discount_rule', { list: listDiscountRules, parse: parseDiscountRule, create: createDiscountRule });

export const GET = handlers.GET;
export const POST = handlers.POST;
