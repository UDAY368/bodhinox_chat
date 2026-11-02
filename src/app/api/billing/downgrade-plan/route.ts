// /api/billing/downgrade-plan — workspace admins only.
//   GET                          the target plan (scheduled change, else current), what
//                                exceeds its limits, the stored choice and what is archived
//   POST { plan, keep }          keep: { segments?, lists?, flows?, automations?: id[] }
//                                stores which items stay active under `plan`; applied now
//                                when that plan is already in effect, else when it starts.
// Nothing is deleted: items that do not fit are archived. POST needs Origin + CSRF proof.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { DowngradeInputError, downgradeOverview, parseSelection, saveDowngradeSelection } from '@/lib/billing/downgrade';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.billing.downgrade');
const noStore = { 'Cache-Control': 'private, no-store' };

async function requireAdmin(request: Request, mutation: boolean) {
  const session = await requireSession(request);
  if (mutation) await assertMutation(request, session);
  if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Billing requires an admin role');
  // Saving a choice also needs the 'settings.billing' permission (a workspace may take it from admins).
  if (mutation) await requirePermission({ accountId: session.accountId, userId: session.userId, role: session.role }, 'settings.billing');
  return session;
}

export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request, false);
    const overview = await withTenant({ accountId: session.accountId, userId: session.userId, role: session.role },
      (tx) => downgradeOverview(tx, session.accountId));
    return NextResponse.json(overview, { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request, true);
    const limit = checkRateLimit(`billingDowngrade:${session.accountId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as { plan?: unknown; keep?: unknown } | null;
    if (!body || typeof body.plan !== 'string' || !body.plan) throw new DowngradeInputError('invalid_selection');
    const keep = parseSelection(body.keep ?? {});
    const ctx = { accountId: session.accountId, userId: session.userId, role: session.role };
    const result = await withTenant(ctx, async (tx) => {
      const { applied } = await saveDowngradeSelection(tx, session.accountId, session.userId, body.plan as string, keep);
      return { applied, ...(await downgradeOverview(tx, session.accountId)) };
    });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof DowngradeInputError)
      return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status, headers: noStore });
    return toErrorResponse(error);
  }
}
