// POST /api/commerce/shop/csv/preview (body: the CSV text, up to 5 MB and 5,000 rows) — a dry run, nothing is written (admins).
//   200 { preview: { mode: 'inline'|'queued', total_rows, create, update, new_products, error_count, errors: [{row, field, code}], sample } }.
export const runtime = 'nodejs';

import { asCatalogueError, checkCsvText, prepareImport, previewOf } from '@/lib/commerce/catalogue/product-csv-import';
import { MAX_CSV_BYTES } from '@/lib/commerce/catalogue/product-csv';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readCsvBody, staffCaller } from '../../_lib/http';

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = await mutationLimit(caller);
    if (limited) return limited;
    const csv = checkCsvText(await readCsvBody(request, MAX_CSV_BYTES));
    const prepared = await inTenant(caller, (tx) => prepareImport(tx, caller.accountId, csv)).catch((e) => { throw asCatalogueError(e); });
    return json({ preview: previewOf(prepared) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
