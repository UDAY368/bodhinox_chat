// GET  /api/commerce/price-lists — the wholesale price lists (a contact tag, and prices per variant with a minimum quantity) of the workspace (agents and above).
// POST /api/commerce/price-lists — create one (admins). 201 { price_list }; 409 price_rule_limit (20 lists).

import { createPriceList, listPriceLists, parsePriceList } from '@/lib/commerce/price-rules-store';
import { collectionHandlers } from '@/lib/commerce/rule-http';

const handlers = collectionHandlers('price-lists', 'price_lists', 'price_list', { list: listPriceLists, parse: parsePriceList, create: createPriceList });

export const GET = handlers.GET;
export const POST = handlers.POST;
