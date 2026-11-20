// GET /api/contacts/[id]/payments?page=<0-based> (agent and above) — one page of
// the money this contact paid (through their orders, payment links or
// appointments), newest first, with the total for the pager. Ids, amounts,
// statuses and codes only. Another workspace's contact is 404.
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { UUID_RE } from '@/lib/contacts/profile';
import { contactPaymentsPage } from '@/lib/contacts/commerce-summary';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const raw = new URL(request.url).searchParams.get('page') ?? '0';
    if (!/^\d{1,4}$/.test(raw)) return NextResponse.json({ error: 'invalid_page' }, { status: 400 });
    const result = await contactPaymentsPage(tenantOf(ctx), id, Number(raw));
    if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
