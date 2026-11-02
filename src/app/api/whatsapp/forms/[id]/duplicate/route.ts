// POST /api/whatsapp/forms/[id]/duplicate — copy a form into a new draft named
// "<name> (copy)" (then "(copy 2)", ...) with no Meta flow (admin). 201 { form }.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { duplicateForm, formErrorResponse } from '@/lib/whatsapp/forms/service';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`forms:write:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json({ form: await duplicateForm(tenantOf(ctx), id) }, { status: 201 });
  } catch (error) {
    return formErrorResponse(error);
  }
}
