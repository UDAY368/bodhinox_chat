// POST /api/whatsapp/forms/[id]/publish — compile, upload and publish the form on
// Meta (admin, rate limited). 200 { form }. 409 when WhatsApp is not connected, an
// endpoint form has no encryption key, or the form is no longer a draft;
// 422 { error, errors } when our validator or Meta rejects the Flow JSON
// (Meta's errors are stored on the form); 502 when Meta fails. Retrying is safe.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { formErrorResponse, publishForm } from '@/lib/whatsapp/forms/service';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`forms:publish:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json({ form: await publishForm(tenantOf(ctx), id) });
  } catch (error) {
    return formErrorResponse(error);
  }
}
