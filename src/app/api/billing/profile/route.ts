// GET /api/billing/profile — admins: the GST billing profile, or { profile: null }.
// PUT /api/billing/profile — admins with the 'settings.billing' permission: create or replace it
//   (Origin + CSRF proof required).
//   { legal_name, gstin?, address_line1, address_line2?, city, state_code?, postal_code, country?: 'IN', email }
//   A GSTIN must pass its checksum; for India the state code is required (taken
//   from the GSTIN when omitted) and must match the GSTIN.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { badRequest, billingErrorResponse, jsonBody, NO_STORE } from '@/lib/billing/http';
import { getBillingProfile, parseBillingProfile, saveBillingProfile } from '@/lib/billing/profile';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const profile = await withTenant(tenantOf(ctx), (tx) => getBillingProfile(tx, ctx.accountId));
    return NextResponse.json({ profile }, { headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    await assertMutation(request, await requireSession(request));
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'settings.billing');
    const limit = checkRateLimit(`billingProfile:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await jsonBody(request);
    if (!body) return badRequest('invalid_request');
    const input = parseBillingProfile(body);
    const profile = await withTenant(tenantOf(ctx), (tx) => saveBillingProfile(tx, ctx.accountId, input));
    return NextResponse.json({ profile }, { headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(error);
  }
}
