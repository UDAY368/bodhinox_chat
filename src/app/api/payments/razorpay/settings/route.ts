// GET    /api/payments/razorpay/settings — whether Razorpay is connected (any member).
// PUT    /api/payments/razorpay/settings — connect or replace the keys (admin), after
//        Razorpay accepts them. Body: { key_id, key_secret, webhook_secret?, mode? }.
//        A missing webhook_secret keeps the stored one.
// DELETE /api/payments/razorpay/settings — disconnect (admin).
// Secrets are encrypted at rest and never returned; the response says only
// whether a webhook secret is stored.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { appOrigin } from '@/lib/auth/csrf';
import { tenantOf } from '@/lib/audience/http';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { deletePaymentProvider, getPaymentProvider, PaymentProviderError, savePaymentProvider } from '@/lib/payments/providers';
import { keyMode, testCredentials } from '@/lib/payments/razorpay';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const t = getT('Validation.payments');
const headers = { 'Cache-Control': 'private, no-store' };
const SECRET_MAX = 200;

export interface RazorpaySettingsBody {
  connected: boolean;
  mode: 'test' | 'live' | null;
  key_id: string | null;
  connected_at: string | null;
  webhook_secret_set: boolean;
  /** Paste into Razorpay → Settings → Webhooks, with events payment_link.*. */
  webhook_url: string;
}

function webhookUrl(accountId: string): string {
  let origin = 'http://localhost:3000';
  try { origin = appOrigin(); } catch { /* unset in some local setups */ }
  return `${origin}/api/payments/razorpay/webhook/${accountId}`;
}

/** Whether a webhook secret is stored, read through the worker role without decrypting it. */
async function webhookSecretSet(accountId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ set: boolean }[]>`
    SELECT webhook_secret_enc IS NOT NULL AS set FROM payment_providers WHERE account_id=${accountId}::uuid AND provider='razorpay'`, getWorkerPrisma());
  return rows[0]?.set === true;
}

async function body(accountId: string, provider: Awaited<ReturnType<typeof getPaymentProvider>>): Promise<RazorpaySettingsBody> {
  return {
    connected: !!provider,
    mode: provider?.mode ?? null,
    key_id: provider?.key_id ?? null,
    connected_at: provider ? new Date(provider.connected_at).toISOString() : null,
    webhook_secret_set: provider ? await webhookSecretSet(accountId) : false,
    webhook_url: webhookUrl(accountId),
  };
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const provider = await withTenant(tenantOf(ctx), (tx) => getPaymentProvider(tx, ctx.accountId));
    return NextResponse.json(await body(ctx.accountId, provider), { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Whether a commerce key id is the platform's SaaS billing key (BILLING_RAZORPAY_KEY_ID). Read
 * straight from the environment: commerce code imports nothing from the billing modules. False
 * while the platform key is unset.
 */
function isPlatformBillingKey(keyId: string, env: Record<string, string | undefined> = process.env): boolean {
  const platform = env.BILLING_RAZORPAY_KEY_ID?.trim();
  return !!platform && keyId.trim() === platform;
}

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`razorpaySettings:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    let input: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      input = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: t('invalidSettings') }, { status: 400 });
    }
    const keyId = text(input.key_id, 100);
    const keySecret = text(input.key_secret, SECRET_MAX);
    const mode = keyId ? keyMode(keyId) : null;
    if (!keyId || !keySecret || !mode) return NextResponse.json({ error: t('invalidKey'), code: 'invalid_key' }, { status: 400 });
    if (input.mode !== undefined && input.mode !== mode) return NextResponse.json({ error: t('modeMismatch'), code: 'mode_mismatch' }, { status: 400 });
    // The platform's own subscription account must never double as a workspace's commerce account.
    if (isPlatformBillingKey(keyId)) return NextResponse.json({ error: t('platformKeyReuse'), code: 'platform_key_reuse' }, { status: 400 });
    let webhookSecret: string | undefined;
    if (input.webhook_secret !== undefined && input.webhook_secret !== null && input.webhook_secret !== '') {
      const value = text(input.webhook_secret, SECRET_MAX);
      if (!value) return NextResponse.json({ error: t('invalidWebhookSecret'), code: 'invalid_webhook_secret' }, { status: 400 });
      webhookSecret = value;
    }

    const check = await testCredentials({ keyId, keySecret });
    if (!check.ok) {
      return check.reason === 'auth'
        ? NextResponse.json({ error: t('keyRejected'), code: 'auth' }, { status: 400 })
        : NextResponse.json({ error: t('providerUnreachable'), code: 'unreachable' }, { status: 502 });
    }
    const provider = await withTenant(tenantOf(ctx), (tx) => savePaymentProvider(tx, ctx.accountId, { keyId, keySecret, webhookSecret }));
    return NextResponse.json(await body(ctx.accountId, provider), { headers });
  } catch (error) {
    if (error instanceof PaymentProviderError) return NextResponse.json({ error: t('invalidKey'), code: 'invalid_key' }, { status: 400 });
    return toErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`razorpaySettings:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const removed = await withTenant(tenantOf(ctx), (tx) => deletePaymentProvider(tx, ctx.accountId));
    return NextResponse.json({ removed }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
