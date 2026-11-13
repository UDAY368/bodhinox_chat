// POST /api/broadcasts/instagram/estimate { audience } — how many of an audience's contacts
// are on Instagram and how many of them are inside their 24-hour window now. Read-only.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { countInstagramAudience } from '@/lib/broadcasts/instagram';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = await request.json().catch(() => null);
    return NextResponse.json(await countInstagramAudience(tenantOf(ctx), body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
