// /api/custom-fields — the workspace's custom contact fields (src/lib/contacts/custom-fields.ts).
//   GET  (any member) — every field with its type, choices, how many contacts have a value
//        and how many saved segments use it.
//   POST (admin+) — { name, type: 'text'|'number'|'date'|'choice', choices?: string[] }.
// The proxy enforces Origin and CSRF on every mutation.
import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createCustomField, customFieldError, listCustomFields } from '@/lib/contacts/custom-fields';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({ fields: await listCustomFields(tenantOf(ctx)) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return customFieldError(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const field = await createCustomField(tenantOf(ctx), await request.json().catch(() => null));
    return NextResponse.json({ field }, { status: 201 });
  } catch (error) {
    return customFieldError(error);
  }
}
