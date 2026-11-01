// ============================================================
// /api/workspace-attributes — {{workspace.key}} values (lib/workspace/attributes).
//   GET  — list; secret values are never returned (any member)
//   POST — create or replace { key, value, is_secret? } (admin+)
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { listAttributes, saveAttribute } from '@/lib/workspace/attributes';
import { attributeError } from '@/lib/workspace/http';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({ attributes: await listAttributes(tenantOf(ctx)) });
  } catch (err) {
    return attributeError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const attribute = await saveAttribute(tenantOf(ctx), await request.json().catch(() => null));
    return NextResponse.json({ attribute });
  } catch (err) {
    return attributeError(err);
  }
}
