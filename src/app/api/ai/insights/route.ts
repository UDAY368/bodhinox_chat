// GET  /api/ai/insights — the workspace's insights switch, the insights the
//   caller may request, and their latest runs (an admin sees everyone's):
//   200 { enabled, keys, runs }. Agent or above with 'ai.insights'.
// POST /api/ai/insights — request one insight: { key, preset? | from?, to? }
//   (analytics range presets or custom local days, at most 366 days). The run
//   row and its worker job commit before 202 { run }. The numbers come from a
//   fixed reporting query; a model narrative is added only when AI is
//   available, otherwise a template narrative. 400 invalid key or range,
//   403 role or permission, 409 insights switched off, 429 too many runs
//   queued or requests. Session and CSRF are enforced by the proxy.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { insightErrorResponse } from '@/lib/ai/insights/http';
import { INSIGHT_KEYS, insightAllowed } from '@/lib/ai/insights/registry';
import { insightsEnabled, listInsightRuns, requestInsight } from '@/lib/ai/insights/runs';

const noStore = { 'Cache-Control': 'private, no-store' };
const text = (value: unknown) => (typeof value === 'string' && value.length <= 32 ? value : null);

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'ai.insights');
    const actor = { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role };
    const [enabled, runs] = await Promise.all([insightsEnabled(actor), listInsightRuns(actor)]);
    return NextResponse.json({ enabled, keys: INSIGHT_KEYS.filter((k) => insightAllowed(ctx.role, k)), runs }, { headers: noStore });
  } catch (error) {
    return insightErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'ai.insights');
    const user = checkRateLimit(`ai-insights:user:${ctx.userId}`, RATE_LIMITS.aiAssistUser);
    if (!user.success) return rateLimitResponse(user);
    const account = checkRateLimit(`ai-insights:account:${ctx.accountId}`, RATE_LIMITS.aiAssistAccount);
    if (!account.success) return rateLimitResponse(account);
    const raw: unknown = await request.json().catch(() => null);
    // Anything but an object has no valid key: requestInsight refuses it with 400 invalid_key.
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const run = await requestInsight(
      { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role },
      { key: body.key, range: { preset: text(body.preset), from: text(body.from), to: text(body.to) } },
    );
    return NextResponse.json({ run }, { status: 202, headers: noStore });
  } catch (error) {
    return insightErrorResponse(error);
  }
}
