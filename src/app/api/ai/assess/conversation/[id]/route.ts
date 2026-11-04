// GET /api/ai/assess/conversation/:id (agents and above, 'ai.assist') — the
//   conversation's current advisory assessment: 200 { enabled, assessment }
//   where assessment is null until one exists. Read-only: no provider call,
//   no write. A conversation outside the caller's workspace is 404. Viewers
//   cannot read assessments (a lead score is sales-sensitive; RLS agrees).

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { readAiSettings } from '@/lib/ai/settings';
import { conversationExists, readCurrentAssessment } from '@/lib/ai/assess/repo';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api');
const noStore = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'ai.assist');
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const view = await withTenant(tenantOf(ctx), async (tx) => {
      if (!(await conversationExists(tx, ctx.accountId, id))) return null;
      return {
        enabled: (await readAiSettings(tx, ctx.accountId)).assessment_enabled,
        assessment: await readCurrentAssessment(tx, ctx.accountId, id),
      };
    });
    if (!view) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    return NextResponse.json(view, { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}
