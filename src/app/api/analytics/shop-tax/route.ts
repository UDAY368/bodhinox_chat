// GET /api/analytics/shop-tax?preset=&from=&to= — the GST report from the receipts and credit notes already issued: taxable value,
//   tax and the CGST/SGST/IGST split per month and rate (admins and owners). The CSV is /api/analytics/shop-tax/export.

import { analyticsReport } from '@/lib/analytics/http';
import { taxReport } from '@/lib/commerce/shop-reports';

export async function GET(request: Request) {
  return analyticsReport(request, 'admin', async ({ tx, accountId, range }) => ({ tax: await taxReport(tx, accountId, range) }));
}
