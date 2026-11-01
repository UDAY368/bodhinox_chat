// ============================================================
// /api/account/webhooks — dashboard management of outbound webhooks.
//
//   GET  — list endpoints (any member; the signing secret never leaves
//          the server after creation).
//   POST — register an endpoint (admin+). The plaintext secret is
//          returned exactly once, same contract as API keys.
//
// Same validation and storage as /api/v1/webhooks (lib/webhooks/manage).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { createWebhook, listWebhooks, WebhookInputError } from '@/lib/webhooks/manage';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({ webhooks: await listWebhooks(ctx.db, ctx.accountId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:webhookCreate:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const created = await createWebhook(ctx.db, ctx.accountId, ctx.userId, await request.json().catch(() => null));
    return NextResponse.json({ webhook: created }, { status: 201 });
  } catch (err) {
    if (err instanceof WebhookInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    return toErrorResponse(err);
  }
}
