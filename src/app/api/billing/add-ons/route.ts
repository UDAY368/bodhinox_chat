// /api/billing/add-ons — workspace admins only.
//   GET                       the configured packs and this workspace's add-ons
//   POST { kind, packs? }     buy packs, charged on the subscription's next invoice
//   DELETE ?id=<add-on id>    stop an active add-on now (no refund)
// Mutations need the live session's Origin + CSRF proof. Provider ids stay server-side.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { addonPacks, AddonInputError, cancelAddon, listAddons, parsePurchase, purchaseAddon } from '@/lib/billing/addons';
import { sellerStateCode } from '@/lib/billing/gst';
import { getBillingProvider } from '@/lib/billing/razorpay-billing';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.billing.addOns');
const noStore = { 'Cache-Control': 'private, no-store' };

async function requireAdmin(request: Request, mutation: boolean) {
  const session = await requireSession(request);
  if (mutation) await assertMutation(request, session);
  if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Billing requires an admin role');
  // Buying or stopping add-ons also needs the 'settings.billing' permission (a workspace may take it from admins).
  if (mutation) await requirePermission({ accountId: session.accountId, userId: session.userId, role: session.role }, 'settings.billing');
  return session;
}

function refusal(error: unknown): NextResponse | null {
  if (!(error instanceof AddonInputError)) return null;
  return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status, headers: noStore });
}

export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request, false);
    const addOns = await withTenant({ accountId: session.accountId, userId: session.userId, role: session.role },
      (tx) => listAddons(tx, session.accountId));
    const packs = addonPacks();
    return NextResponse.json({ configured: getBillingProvider() !== null && sellerStateCode() !== null && packs.length > 0, packs, addOns }, { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request, true);
    const limit = checkRateLimit(`billingAddons:${session.accountId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const provider = getBillingProvider();
    // GST is added to every pack and invoiced; both need the seller's state.
    if (!provider || !sellerStateCode()) return NextResponse.json({ error: t('notConfigured'), code: 'not_configured' }, { status: 503, headers: noStore });
    const { pack, packs } = parsePurchase(await request.json().catch(() => null), addonPacks());
    const result = await purchaseAddon(provider, { accountId: session.accountId, userId: session.userId, pack, packs });
    if (result.status === 'failed')
      return NextResponse.json({ ...result, error: t('rejected'), code: 'rejected' }, { status: 422, headers: noStore });
    // pending: the provider's answer was lost; the add-on is not granted until reconciled.
    return NextResponse.json(result, { status: result.status === 'active' ? 201 : 202, headers: noStore });
  } catch (error) {
    return refusal(error) ?? toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireAdmin(request, true);
    await cancelAddon(session.accountId, session.userId, new URL(request.url).searchParams.get('id') ?? '');
    return NextResponse.json({ status: 'cancelled' }, { headers: noStore });
  } catch (error) {
    return refusal(error) ?? toErrorResponse(error);
  }
}
