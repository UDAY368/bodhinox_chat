// GET /api/commerce/shop/csv/export — the catalogue as a CSV download, one row per active variant (admins). 200 text/csv.
//   Cells that could run as a spreadsheet formula carry a leading apostrophe.
export const runtime = 'nodejs';

import { exportProductsCsv } from '@/lib/commerce/catalogue/product-csv-import';
import { catalogueErrorResponse, inTenant, mutationLimit, noStore, staffCaller } from '../../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const { csv } = await inTenant(caller, (tx) => exportProductsCsv(tx, caller.accountId));
    return new Response(csv, {
      headers: {
        ...noStore,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
