// ============================================================
// PATCH  /api/account/webhooks/[id] — change url/events/is_active (admin+)
// DELETE /api/account/webhooks/[id] — remove an endpoint (admin+)
//
// A foreign or unknown id is a 404; account_id scoping plus the
// admin-only webhook_endpoints RLS policy both enforce tenancy.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { deleteWebhook, updateWebhook, WebhookInputError } from '@/lib/webhooks/manage';

const notFound = () => NextResponse.json({ error: 'Webhook not found' }, { status: 404 });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:webhookUpdate:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const updated = await updateWebhook(ctx.db, ctx.accountId, id, await request.json().catch(() => null));
    return updated ? NextResponse.json({ webhook: updated }) : notFound();
  } catch (err) {
    if (err instanceof WebhookInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:webhookDelete:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    return (await deleteWebhook(ctx.db, ctx.accountId, id)) ? NextResponse.json({ success: true }) : notFound();
  } catch (err) {
    return toErrorResponse(err);
  }
}
