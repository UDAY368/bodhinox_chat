// /api/meta-ads/rules — automated ad rules.
// GET (any member): { rules, actions } — the rules and the latest 20 things they did.
// POST (admin, CSRF):
//   { action: 'create', name, level, metric, operator, threshold, windowDays, minSpend?, ruleAction: 'pause'|'notify' }
//     — `ruleAction` is what the rule does (`action` names the request); 201 { rule }.
//   { action: 'enable', id, enabled } — on or off; 200 { rule }.
//   { action: 'delete', id } — 200.
// 503 meta_ads_not_enabled / manage_not_enabled (pause rules), 400 invalid_request, 403, 404, 409 limit_reached, 429.

import { NextResponse } from 'next/server';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { createAdRule, deleteAdRule, listAdRules, parseAdRuleInput, setAdRuleEnabled } from '@/lib/meta-ads/rules';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    return NextResponse.json(await listAdRules(actorOf(session)), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = await checkRateLimit(`metaAdsRules:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const actor = actorOf(session);
    switch (body?.action) {
      case 'create': {
        const input = parseAdRuleInput({ ...body, action: body.ruleAction });
        if (!input) return metaAdsErrorResponse('invalid_request');
        return NextResponse.json({ rule: await createAdRule(actor, input) }, { status: 201, headers: NO_STORE });
      }
      case 'enable':
        if (typeof body.id !== 'string' || !UUID.test(body.id) || typeof body.enabled !== 'boolean') return metaAdsErrorResponse('invalid_request');
        return NextResponse.json({ rule: await setAdRuleEnabled(actor, body.id, body.enabled) }, { headers: NO_STORE });
      case 'delete':
        if (typeof body.id !== 'string' || !UUID.test(body.id)) return metaAdsErrorResponse('invalid_request');
        await deleteAdRule(actor, body.id);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      default:
        return metaAdsErrorResponse('invalid_request');
    }
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
