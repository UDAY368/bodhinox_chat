// POST /api/ai/assess/conversation/:id/refresh (agents and above, 'ai.assess')
//   — queues a fresh advisory assessment for the conversation. The job and the
//   jobs row commit together before the 202 { status: 'queued' |
//   'already_queued' } (one manual run per conversation per 10 minutes). 409
//   { code: 'feature_off' } when the workspace has not turned assessments on;
//   404 for a conversation outside the caller's workspace. Queuing calls no
//   provider; the job asks the model only when the deployment switch is not
//   off and the workspace has a key and room in its limits, else it keeps the
//   keyword result. Session and CSRF are enforced by the proxy.

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { readAiSettings } from '@/lib/ai/settings';
import { conversationExists, queueAssessmentRefresh } from '@/lib/ai/assess/repo';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'ai.assess');
    const user = checkRateLimit(`ai-assist-user:${ctx.userId}`, RATE_LIMITS.aiAssistUser);
    if (!user.success) return rateLimitResponse(user);
    const account = checkRateLimit(`ai-assist-account:${ctx.accountId}`, RATE_LIMITS.aiAssistAccount);
    if (!account.success) return rateLimitResponse(account);
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const outcome = await withTenant(tenantOf(ctx), async (tx) => {
      if (!(await conversationExists(tx, ctx.accountId, id))) return 'not_found' as const;
      if (!(await readAiSettings(tx, ctx.accountId)).assessment_enabled) return 'feature_off' as const;
      return queueAssessmentRefresh(tx, ctx.accountId, id);
    });
    if (outcome === 'not_found') return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    if (outcome === 'feature_off') return NextResponse.json({ error: 'feature_off', code: 'feature_off' }, { status: 409 });
    return NextResponse.json({ status: outcome }, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
