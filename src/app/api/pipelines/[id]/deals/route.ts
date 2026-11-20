// GET /api/pipelines/{id}/deals?stage=<stageId>&offset=<n>&view=open|won|lost&owner=...&q=...
// One more page (25) of a stage's deals ("Load more"), newest first (any member).
// 200 { deals, hasMore }; 400 invalid filters or offset; 404 not_found (no such pipeline or stage id here).
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { boardErrorResponse, loadStageDeals, parseBoardFilters, parseOffset } from '@/lib/pipelines/board';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const filters = parseBoardFilters(params);
    const offset = parseOffset(params.get('offset'));
    const page = await loadStageDeals(tenantOf(ctx), id, params.get('stage') ?? '', filters, offset);
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
