// GET /api/commerce/shop/csv/jobs — the latest queued imports with their progress (admins). 200 { jobs }.
export const runtime = 'nodejs';

import { listImportJobs } from '@/lib/commerce/catalogue/product-csv-import';
import { catalogueErrorResponse, inTenant, json, staffCaller } from '../../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin' });
    return json({ jobs: await inTenant(caller, (tx) => listImportJobs(tx, caller.accountId)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
