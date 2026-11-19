// GET  /api/commerce/gift-rules — the free gift rules (spend an amount or buy a product, get a variant free) of the workspace (agents and above).
// POST /api/commerce/gift-rules — create one (admins). 201 { gift_rule }; 409 price_rule_limit (10 rules).

import { createGiftRule, listGiftRules, parseGiftRule } from '@/lib/commerce/price-rules-store';
import { collectionHandlers } from '@/lib/commerce/rule-http';

const handlers = collectionHandlers('gift-rules', 'gift_rules', 'gift_rule', { list: listGiftRules, parse: parseGiftRule, create: createGiftRule });

export const GET = handlers.GET;
export const POST = handlers.POST;
