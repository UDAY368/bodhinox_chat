// GET /api/analytics/commerce?preset=&from=&to=
// Commerce revenue for the range (agent role and above: customer payments and
// refunds are RLS-hidden from viewers, so a viewer would see a misleading
// zero). Per currency, in integer minor units: gross and net merchandise,
// discounts, tax, shipping, average order value, collected (gateway and
// offline), refunds (including external) and net collections, plus a daily
// ledger. Amounts and counts only; no customer data.

import { analyticsReport } from '@/lib/analytics/http';
import { commerceStats } from '@/lib/analytics/commerce';

export async function GET(request: Request) {
  return analyticsReport(request, 'agent', async ({ tx, accountId, range }) => ({
    stats: await commerceStats(tx, accountId, range),
  }));
}
