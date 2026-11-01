// ============================================================
// GET  /api/v1/webhooks — list webhook endpoints (scope: webhooks:manage)
// POST /api/v1/webhooks — register an endpoint    (scope: webhooks:manage)
//
// POST returns the signing `secret` in plaintext exactly once — store
// it to verify the `X-Wacrm-Signature` on deliveries. wacrm keeps only
// an encrypted copy and can never show it again.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { createWebhook, listWebhooks, WebhookInputError } from '@/lib/webhooks/manage';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    // The roster is small and settings-class — return it whole (the
    // list envelope's cursor is always null here).
    return okList(await listWebhooks(ctx.db, ctx.accountId), null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const body = await request.json().catch(() => null);
    return ok(await createWebhook(ctx.db, ctx.accountId, ctx.createdBy, body), 201);
  } catch (err) {
    if (err instanceof WebhookInputError) return fail('bad_request', err.message, 400);
    return toApiErrorResponse(err);
  }
}
