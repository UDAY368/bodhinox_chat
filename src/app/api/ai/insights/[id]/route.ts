// GET /api/ai/insights/:id — one insight run the caller may read (their own,
//   or any for an admin): 200 { run }; 404 otherwise, including another
//   workspace's run. Agent or above with 'ai.insights'.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { insightErrorResponse } from '@/lib/ai/insights/http';
import { getInsightRun } from '@/lib/ai/insights/runs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'ai.insights');
    const run = await getInsightRun({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, (await params).id);
    return NextResponse.json({ run }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return insightErrorResponse(error);
  }
}
