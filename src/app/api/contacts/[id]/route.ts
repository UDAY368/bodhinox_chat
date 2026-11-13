// /api/contacts/[id] — the full-page contact profile (src/lib/contacts/profile.ts).
//   GET   (any member) — the read-only sections: conversations the member may see,
//         orders (agent+ by RLS), Instagram usernames and the timeline.
//   PATCH (agent+) — saves one field as it is edited:
//         { field: 'name'|'email'|'company'|'city'|'phone'|'owner_id', value: string }
//         { field: 'blocked', value: boolean }
//         { customFieldId: <uuid>, value: string }  ('' clears)
//         Each change is checked (number format and duplicates, owner is a member,
//         custom value fits its type) and recorded in contact_activity.
// Another workspace's contact is 404. The proxy enforces Origin and CSRF on every mutation.
import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { contactOverview, ProfileError, setContactCustomValue, updateContactField } from '@/lib/contacts/profile';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const overview = await contactOverview(tenantOf(ctx), id);
    if (!overview) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(overview, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { field?: unknown; customFieldId?: unknown; value?: unknown } | null;
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_field' }, { status: 400 });
    if ('customFieldId' in body) {
      const saved = await setContactCustomValue(tenantOf(ctx), id, body.customFieldId, body.value);
      if (!saved) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      return NextResponse.json({ ok: true, ...saved });
    }
    const contact = await updateContactField(tenantOf(ctx), id, body.field, body.value);
    if (!contact) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, contact });
  } catch (error) {
    if (error instanceof ProfileError) return NextResponse.json({ error: error.code }, { status: error.status });
    return toErrorResponse(error);
  }
}
