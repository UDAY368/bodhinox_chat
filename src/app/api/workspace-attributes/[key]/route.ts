// DELETE /api/workspace-attributes/[key] — remove one attribute (admin+).

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { deleteAttribute } from '@/lib/workspace/attributes';
import { attributeError } from '@/lib/workspace/http';

export async function DELETE(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const { key } = await params;
    return (await deleteAttribute(tenantOf(ctx), key))
      ? NextResponse.json({ success: true })
      : NextResponse.json({ error: 'Attribute not found' }, { status: 404 });
  } catch (err) {
    return attributeError(err);
  }
}
