// POST /api/broadcasts/instagram { name, text, audience } — send a free-text Instagram
// campaign now to the audience's contacts whose 24-hour window is open (agent+ with
// campaigns.send). The campaign, its recipients and the dispatch job commit together;
// the worker sends each through its outbound intent (lib/broadcasts/instagram).

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { requirePermission } from '@/lib/auth/permissions';
import { createInstagramBroadcast } from '@/lib/broadcasts/instagram';
import { InstagramError } from '@/lib/instagram/errors';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const body = await request.json().catch(() => null);
    const result = await createInstagramBroadcast(tenantOf(ctx), body);
    return NextResponse.json(result, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof InstagramError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return toErrorResponse(error);
  }
}
