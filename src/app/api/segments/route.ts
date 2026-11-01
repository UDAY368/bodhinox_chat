// ============================================================
// /api/segments — saved audience segments (lib/audience/segments).
//   GET  — list (any member)
//   POST — create { name, filter } (agent+; RLS enforces it too)
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { createSegment, listSegments } from '@/lib/audience/segments';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({ segments: await listSegments(tenantOf(ctx)) });
  } catch (err) {
    return audienceError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const segment = await createSegment(tenantOf(ctx), await request.json().catch(() => null));
    return NextResponse.json({ segment }, { status: 201 });
  } catch (err) {
    return audienceError(err);
  }
}
