// GET /api/pipelines/{id}/board?view=open|won|lost&owner=all|none|<profileId>&q=<search>
// The first page (25) of every stage's deals for the view, each stage's count and
// value per currency, and the pipeline overview per status and currency (any member).
// 200 { stages, deals, overview, pageSize }; 400 invalid filters; 404 not_found (no such pipeline here).
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { BOARD_PAGE_SIZE, boardErrorResponse, loadBoard, parseBoardFilters } from '@/lib/pipelines/board';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await context.params;
    const filters = parseBoardFilters(new URL(request.url).searchParams);
    const board = await loadBoard(tenantOf(ctx), id, filters);
    return NextResponse.json({ ...board, pageSize: BOARD_PAGE_SIZE }, { headers: NO_STORE });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
