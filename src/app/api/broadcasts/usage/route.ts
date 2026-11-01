// GET /api/broadcasts/usage — unique contacts campaigns reached in the last 24 hours
// (any member). Paired with /api/whatsapp/health's daily tier for the campaign header;
// sends outside campaigns are not counted, so the remaining figure is an estimate.

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const [{ contacts }] = await withTenant(tenantOf(ctx), (tx) => tx.$queryRaw<{ contacts: number }[]>`
      SELECT count(DISTINCT contact_id)::int AS contacts FROM broadcast_recipients
      WHERE account_id=${ctx.accountId}::uuid AND sent_at > now() - interval '24 hours'`);
    return NextResponse.json({ campaignContacts24h: contacts }, { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
