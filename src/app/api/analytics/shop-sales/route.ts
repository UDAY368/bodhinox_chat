// GET /api/analytics/shop-sales?preset=&from=&to= — sales by product, by day and by channel, net of refunds, per currency in minor
//   units (admins and owners; at most 366 days). Amounts and counts only, no customer data.

import { analyticsReport } from '@/lib/analytics/http';
import { salesReport } from '@/lib/commerce/shop-reports';

export async function GET(request: Request) {
  return analyticsReport(request, 'admin', async ({ tx, accountId, range }) => ({ sales: await salesReport(tx, accountId, range) }));
}
