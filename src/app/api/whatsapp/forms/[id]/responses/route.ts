// GET /api/whatsapp/forms/[id]/responses?cursor=&limit= — submissions, newest first.
// Any member: answers are conversation content, and every member can read the
// inbox (conversations and messages are readable to viewers too).
// 200 { responses: [{ id, created_at, contact: { id, name, phone } | null,
//   answers: { field_id: value }, labels: { field_id: label } }], next_cursor }

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { formErrorResponse, listResponses } from '@/lib/whatsapp/forms/service';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('viewer');
    const query = new URL(request.url).searchParams;
    const limit = query.get('limit');
    return NextResponse.json(await listResponses(tenantOf(ctx), id, {
      cursor: query.get('cursor'),
      limit: limit ? Number(limit) : null,
    }));
  } catch (error) {
    return formErrorResponse(error);
  }
}
