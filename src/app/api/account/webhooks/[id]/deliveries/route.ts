// ============================================================
// GET /api/account/webhooks/[id]/deliveries — the endpoint's delivery log (admin+)
//
// Newest first, at most WEBHOOK_DELIVERY_LOG_LIMIT attempts from the past
// 30 days: event, delivery id, attempt, outcome, HTTP status and a short
// error code. The payload is never stored. A foreign or unknown id is a 404;
// withTenant plus the admin-only webhook_deliveries RLS policy enforce tenancy.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { listWebhookDeliveries } from '@/lib/webhooks/manage';

const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:webhookDeliveries:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const deliveries = await listWebhookDeliveries(tenantOf(ctx), id);
    if (!deliveries)
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404, headers: noStore });
    return NextResponse.json({ deliveries }, { headers: noStore });
  } catch (err) {
    return toErrorResponse(err);
  }
}
