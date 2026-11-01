// ============================================================
// /api/lists — static contact lists (lib/audience/lists).
//   GET  — list with member counts (any member)
//   POST — create { name } (agent+; RLS enforces it too)
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { createList, listLists } from '@/lib/audience/lists';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({ lists: await listLists(tenantOf(ctx)) });
  } catch (err) {
    return audienceError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const list = await createList(tenantOf(ctx), await request.json().catch(() => null));
    return NextResponse.json({ list }, { status: 201 });
  } catch (err) {
    return audienceError(err);
  }
}
