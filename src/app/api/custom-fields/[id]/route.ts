// /api/custom-fields/[id] (admin+) — src/lib/contacts/custom-fields.ts.
//   PATCH  { name?, choices? } — rename; replace a choice field's choices (values that are
//          no longer a choice are cleared). The type never changes.
//   DELETE — removes the field, its values and its conditions in saved segments; 409
//          { segments } when a segment has no other condition.
// Another workspace's field is 404. The proxy enforces Origin and CSRF on every mutation.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { customFieldError, deleteCustomField, updateCustomField } from '@/lib/contacts/custom-fields';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const field = await updateCustomField(tenantOf(ctx), id, await request.json().catch(() => null));
    return NextResponse.json({ field });
  } catch (error) {
    return customFieldError(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    return NextResponse.json({ ok: true, ...(await deleteCustomField(tenantOf(ctx), id)) });
  } catch (error) {
    return customFieldError(error);
  }
}
