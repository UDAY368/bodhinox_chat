// GET /api/ai/settings (admins and owners, 'ai.settings') — the workspace's AI
//   assistant switches: 200 { settings, deployment_enabled, configured }.
//   A workspace that never saved has every feature off.
// PUT /api/ai/settings (admins and owners, 'ai.settings') — any of
//   { summaries_enabled, suggestions_enabled, assessment_enabled,
//     insights_enabled: boolean, monthly_token_cap: positive integer | null }.
//   Audited as 'ai.settings_updated'. Turning a feature on calls no provider:
//   it still needs the deployment switch and a configured key. 200 (same shape
//   as GET); 400 invalid. Session and CSRF are enforced by the proxy.

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { aiDeploymentEnabled } from '@/lib/ai/gate';
import { aiConfigured, parseSettingsPatch, readAiSettings, writeAiSettings } from '@/lib/ai/settings';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api');
const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'ai.settings');
    const view = await withTenant(tenantOf(ctx), async (tx) => ({
      settings: await readAiSettings(tx, ctx.accountId),
      deployment_enabled: aiDeploymentEnabled(),
      configured: await aiConfigured(tx, ctx.accountId),
    }));
    return NextResponse.json(view, { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'ai.settings');
    const limit = checkRateLimit(`ai-settings:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const patch = parseSettingsPatch(await request.json().catch(() => null));
    if (!patch) return NextResponse.json({ error: t('common.invalidRequestBody'), code: 'invalid' }, { status: 400 });
    const view = await withTenant(tenantOf(ctx), async (tx) => ({
      settings: await writeAiSettings(tx, { accountId: ctx.accountId, userId: ctx.userId }, patch),
      deployment_enabled: aiDeploymentEnabled(),
      configured: await aiConfigured(tx, ctx.accountId),
    }));
    return NextResponse.json(view, { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}
