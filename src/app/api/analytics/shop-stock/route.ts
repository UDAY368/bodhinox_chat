// GET /api/analytics/shop-stock — stock value: units on hand x the unit cost of the newest purchase order line that received stock,
//   per currency; variants with stock and no such cost are listed apart (admins and owners).

import { analyticsReport } from '@/lib/analytics/http';
import { stockValueReport } from '@/lib/commerce/shop-reports';

export async function GET(request: Request) {
  return analyticsReport(request, 'admin', async ({ tx, accountId }) => ({ stock: await stockValueReport(tx, accountId) }));
}
