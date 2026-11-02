// /api/integrations/commerce-rules — store event → WhatsApp template rules.
//   GET    ?source=woocommerce|shopify   any member
//   PUT    { source, event, enabled, templateName, templateLanguage, whatsappConfigId, delayMinutes, variableMap }   admin
//   DELETE ?source=…&event=…             admin
// Mutations pass the proxy's session origin/CSRF check like every dashboard route.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import {
  CommerceRuleInputError,
  deleteCommerceRule,
  isCommerceEvent,
  isCommerceSource,
  listCommerceRules,
  parseCommerceRuleInput,
  saveCommerceRule,
} from '@/lib/integrations/commerce-rules';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const noStore = { 'Cache-Control': 'private, no-store' };
const bad = (code: string) => NextResponse.json({ error: 'Invalid rule', code }, { status: 400 });

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const source = new URL(request.url).searchParams.get('source');
    if (!isCommerceSource(source)) return bad('source_invalid');
    const rules = await withTenant(tenantOf(ctx), (tx) => listCommerceRules(tx, ctx.accountId, source));
    return NextResponse.json({ rules }, { headers: noStore });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:commerceRule:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseCommerceRuleInput(await request.json().catch(() => null));
    const rule = await withTenant(tenantOf(ctx), (tx) => saveCommerceRule(tx, ctx.accountId, input));
    return NextResponse.json({ rule }, { headers: noStore });
  } catch (err) {
    if (err instanceof CommerceRuleInputError) return bad(err.code);
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const params = new URL(request.url).searchParams;
    const source = params.get('source');
    const event = params.get('event');
    if (!isCommerceSource(source)) return bad('source_invalid');
    if (!isCommerceEvent(event)) return bad('event_invalid');
    const deleted = await withTenant(tenantOf(ctx), (tx) => deleteCommerceRule(tx, ctx.accountId, source, event));
    return deleted ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
