// GET    /api/whatsapp/forms/[id] — one form (any member). 200 { form }.
// PUT    /api/whatsapp/forms/[id] { name?, category?, definition?, uses_endpoint? } — edit (admin).
//   200 { form }; 422 { error, errors } bad definition; 409 when a published form's
//   definition or mode would change (duplicate it instead) or the name is taken.
// DELETE /api/whatsapp/forms/[id] — deprecate (published) or delete (Meta draft) on
//   Meta first, then delete locally (admin). 200 { success: true }; 502 when Meta
//   refuses, with nothing deleted. Another account's id is a 404 everywhere.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { deleteForm, formErrorResponse, getForm, parseFormInput, updateForm } from '@/lib/whatsapp/forms/service';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('viewer');
    return NextResponse.json({ form: await getForm(tenantOf(ctx), id) });
  } catch (error) {
    return formErrorResponse(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`forms:write:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseFormInput(await request.json().catch(() => null), true);
    return NextResponse.json({ form: await updateForm(tenantOf(ctx), id, input) });
  } catch (error) {
    return formErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`forms:write:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    await deleteForm(tenantOf(ctx), id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return formErrorResponse(error);
  }
}
