// GET /api/contacts/bulk/status?ids=a,b,c (any member) — the Instagram status of up to 100
//   contacts shown on the contacts page: 200 { statuses: { [contactId]: 'subscribed' |
//   'unsubscribed' | 'none' } }. Read from stored state only. Another workspace's contact
//   ids are simply left out.
import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { contactChannelStatus } from '@/lib/contacts/bulk';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const ids = (new URL(request.url).searchParams.get('ids') ?? '').split(',').filter(Boolean);
    return NextResponse.json(
      { statuses: await contactChannelStatus(tenantOf(ctx), ids) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    return audienceError(err);
  }
}
