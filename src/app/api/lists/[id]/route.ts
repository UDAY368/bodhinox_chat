// DELETE /api/lists/[id] — remove a list (its contacts stay) (agent+)
// A foreign or unknown id is a 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { deleteList } from '@/lib/audience/lists';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    if (UUID.test(id) && (await deleteList(tenantOf(ctx), id))) return NextResponse.json({ success: true });
    return NextResponse.json({ error: 'List not found' }, { status: 404 });
  } catch (err) {
    return audienceError(err);
  }
}
