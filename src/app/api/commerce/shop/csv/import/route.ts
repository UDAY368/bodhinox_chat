// POST /api/commerce/shop/csv/import (body: the CSV text) — apply the file (admins). The file is read again here, never taken from a preview.
//   Rows with errors are skipped, the rest apply. Up to 200 rows apply now: 200 { result: { mode: 'inline', created, updated, error_count, errors } }.
//   A bigger file is stored and queued: 202 { result: { mode: 'queued', import_id } }. 409 import_running while another import is queued or running.
export const runtime = 'nodejs';

import { importInline, asCatalogueError, checkCsvText, prepareImport, queueImport } from '@/lib/commerce/catalogue/product-csv-import';
import { INLINE_MAX_ROWS, MAX_CSV_BYTES } from '@/lib/commerce/catalogue/product-csv';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readCsvBody, staffCaller } from '../../_lib/http';

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const csv = checkCsvText(await readCsvBody(request, MAX_CSV_BYTES));
    const ctx = { ...caller.tenant, userId: caller.userId };
    const prepared = await inTenant(caller, (tx) => prepareImport(tx, caller.accountId, csv)).catch((e) => { throw asCatalogueError(e); });
    if (prepared.plan.planned.length === 0) return json({ result: { mode: 'inline', created: 0, updated: 0, error_count: prepared.errors.length,
      errors: prepared.errors.slice(0, 200), errors_capped: prepared.errors.length > 200 } });
    if (prepared.totalRows > INLINE_MAX_ROWS) return json({ result: await queueImport(ctx, csv, prepared.totalRows) }, 202);
    return json({ result: await importInline(ctx, csv) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
