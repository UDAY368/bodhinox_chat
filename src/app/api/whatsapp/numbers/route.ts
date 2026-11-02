// GET /api/whatsapp/numbers[?connected=1] — the workspace's WhatsApp numbers,
// default first (any member: the inbox filter and the campaign and flow pickers
// use it). Answers { numbers: WhatsAppNumberDto[] }; every entry carries
// `removed` (true for a number an admin disconnected, which stays listed so
// records that still point at it can name it). `?connected=1` leaves those
// out. Never includes access or verify tokens: the list comes from
// listNumbers' fixed select and toNumberDto's allow-list.

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { toNumberDto } from '@/lib/whatsapp/number-admin';
import { listNumbers } from '@/lib/whatsapp/numbers';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const connectedOnly = ['1', 'true'].includes(new URL(request.url).searchParams.get('connected') ?? '');
    const numbers = (await withTenant(tenantOf(ctx), (tx) => listNumbers(tx, ctx.accountId))).map(toNumberDto);
    return NextResponse.json(
      { numbers: connectedOnly ? numbers.filter((n) => !n.removed) : numbers },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
