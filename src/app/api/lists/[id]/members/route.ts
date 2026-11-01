// POST /api/lists/[id]/members { add?: contactIds[], remove?: contactIds[] }
// — change a list's contacts, up to 1,000 ids each (agent+).

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { changeListMembers } from '@/lib/audience/lists';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const result = UUID.test(id) ? await changeListMembers(tenantOf(ctx), id, await request.json().catch(() => null)) : null;
    return result ? NextResponse.json(result) : NextResponse.json({ error: 'List not found' }, { status: 404 });
  } catch (err) {
    return audienceError(err);
  }
}
