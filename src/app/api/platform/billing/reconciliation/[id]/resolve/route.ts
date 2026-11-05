// POST /api/platform/billing/reconciliation/{id}/resolve (platform admins only, recent MFA,
//   origin checked) - body { note (3-1000 chars) }. Marks the item resolved, audited. Never edits
//   a subscription or an intent: an unknown intent stays until the billing sweep settles it.
//   200 { resolved: true }; 400 note_required / invalid_request, 404 not_found when unknown or
//   already resolved.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { resolveReconciliation } from '@/lib/platform/billing';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request, { mutation: true });
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    await resolveReconciliation(admin, id, body);
    return NextResponse.json({ resolved: true }, { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
