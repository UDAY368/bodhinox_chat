// ============================================================
// GET    /api/v1/webhooks/{id} — read an endpoint   (webhooks:manage)
// PATCH  /api/v1/webhooks/{id} — update url/events/is_active
// DELETE /api/v1/webhooks/{id} — remove an endpoint
//
// All account-scoped: a foreign id → 404 (never 403). The signing
// secret is never returned here — it's shown once at creation only.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';
import { deleteWebhook, updateWebhook, WebhookInputError } from '@/lib/webhooks/manage';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;

    const { data, error } = await ctx.db
      .from('webhook_endpoints')
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/webhooks] read error:', error);
      return fail('internal', 'Failed to read webhook', 500);
    }
    if (!data) return fail('not_found', 'Webhook not found', 404);

    return ok(serializeWebhookEndpoint(data as Record<string, unknown>));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;
    const updated = await updateWebhook(ctx.db, ctx.accountId, id, await request.json().catch(() => null));
    return updated ? ok(updated) : fail('not_found', 'Webhook not found', 404);
  } catch (err) {
    if (err instanceof WebhookInputError) return fail('bad_request', err.message, 400);
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;
    return (await deleteWebhook(ctx.db, ctx.accountId, id))
      ? ok({ id, deleted: true })
      : fail('not_found', 'Webhook not found', 404);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
