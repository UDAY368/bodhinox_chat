// POST /api/contacts/import — one batch (up to IMPORT_BATCH_SIZE rows) of a
// CSV import: { rows: [{ phone, name?, email?, company?, tagIds? }], updateExisting? }.
// Agents and above; the proxy enforces Origin and CSRF on every API mutation.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { importContactBatch } from '@/lib/contacts/import';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = await request.json().catch(() => null);
    return NextResponse.json(await importContactBatch(tenantOf(ctx), body));
  } catch (err) {
    return audienceError(err);
  }
}
