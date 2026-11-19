// GET /api/contacts/[id]/summary (any member) — the chat side panel's Orders,
// Payments and Deals blocks: the newest few of each with their counts, from one
// tenant-scoped statement (src/lib/contacts/commerce-summary.ts). Orders and
// payments are null for a viewer. Another workspace's contact is 404.
import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { UUID_RE } from '@/lib/contacts/profile';
import { contactCommerceSummary } from '@/lib/contacts/commerce-summary';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const summary = await contactCommerceSummary(tenantOf(ctx), id);
    if (!summary) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(summary, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
