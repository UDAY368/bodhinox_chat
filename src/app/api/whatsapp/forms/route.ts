// GET  /api/whatsapp/forms — every form with its response count (any member).
//   200 { forms: [{ id, name, category, status, meta_flow_id, uses_endpoint, published_at, updated_at, response_count }] }
// POST /api/whatsapp/forms { name, category, definition?, uses_endpoint? } — a new draft (admin).
//   201 { form }; 400 bad name/category; 422 { error, errors } bad definition; 409 name taken.
// Forms are not a browser resource; the service runs every query under withTenant.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { createForm, formErrorResponse, listForms, parseFormInput } from '@/lib/whatsapp/forms/service';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    return NextResponse.json({ forms: await listForms(tenantOf(ctx)) });
  } catch (error) {
    return formErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`forms:write:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseFormInput(await request.json().catch(() => null), false);
    return NextResponse.json({ form: await createForm(tenantOf(ctx), input) }, { status: 201 });
  } catch (error) {
    return formErrorResponse(error);
  }
}
