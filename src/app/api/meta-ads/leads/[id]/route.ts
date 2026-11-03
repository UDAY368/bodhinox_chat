// DELETE /api/meta-ads/leads/[id] — admin: erases one lead's answers, keeping a tombstone row
// (for example on a data-erasure request) so backfills never re-import it. The worker
// role writes the tombstone after this admin check; audit meta_leads.delete without content.
// Not gated on the feature flag, so lead PII can be erased while it is off.
// Origin/CSRF is checked by src/proxy.ts for cookie-bearing mutations.
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { deleteLead } from '@/lib/meta-ads/leads';
import { leadsErrorResponse, NO_STORE } from '@/lib/meta-ads/leads-http';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:metaLeadDelete:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const notFound = () => NextResponse.json({ error: 'not_found', message: getT('Api.metaAds')('notFound') }, { status: 404, headers: NO_STORE });
    if (!UUID.test(id)) return notFound();
    if (!(await deleteLead({ accountId: ctx.accountId, userId: ctx.userId }, id))) return notFound();
    return NextResponse.json({ deleted: true }, { headers: NO_STORE });
  } catch (error) {
    return leadsErrorResponse(error);
  }
}
