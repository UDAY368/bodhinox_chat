// GET /api/deals/{id} — one deal with its contact and owner (any member), for the
// /pipelines?deal=<id> link from the chat panel and the contact profile.
// 200 { deal }; 404 not_found (unknown id or another workspace's deal).
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { boardErrorResponse, getDeal } from '@/lib/pipelines/board';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await context.params;
    return NextResponse.json({ deal: await getDeal(tenantOf(ctx), id) }, { headers: NO_STORE });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
