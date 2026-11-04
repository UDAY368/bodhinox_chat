// GET /api/analytics/compare/products?preset=&from=&to=
// Top products by net revenue in the range, per currency (agent and above, as
// /api/analytics/commerce: order lines and refunds are RLS-hidden from
// viewers). Units, gross, discounts, refunds and net in integer minor units.

import { analyticsReport } from '@/lib/analytics/http';
import { productStats } from '@/lib/analytics/products';

export async function GET(request: Request) {
  return analyticsReport(request, 'agent', async ({ tx, accountId, range }) => ({
    products: await productStats(tx, accountId, range),
  }));
}
