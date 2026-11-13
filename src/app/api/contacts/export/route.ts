// GET /api/contacts/export[?segmentId=|?listId=|?ids=a,b] — download contacts as CSV.
// Admin+ only (bulk personal data), rate limited and audit-logged.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { exportContactsCsv, MAX_EXPORT_IDS } from '@/lib/audience/export';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { resolvePhoneMask } from '@/lib/inbox/masking-apply';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'contacts.export');
    // Admins are never masked; kept so a lower export role can't leak numbers.
    if (await resolvePhoneMask(tenantOf(ctx))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const limit = checkRateLimit(`admin:contactsExport:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const query = new URL(request.url).searchParams;
    const segmentId = query.get('segmentId');
    const listId = query.get('listId');
    // ?ids=a,b: the ticked rows or one contact's profile (at most MAX_EXPORT_IDS, this workspace's only).
    const ids = query.get('ids')?.split(',').filter(Boolean) ?? null;
    if ((segmentId && !UUID.test(segmentId)) || (listId && !UUID.test(listId)))
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (ids && (!ids.length || ids.length > MAX_EXPORT_IDS || ids.some((id) => !UUID.test(id))))
      return NextResponse.json({ error: 'Choose between 1 and 100 contacts' }, { status: 400 });
    const { csv } = await exportContactsCsv(tenantOf(ctx), segmentId ? { segmentId } : listId ? { listId } : ids ? { contactIds: ids } : null);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return audienceError(err);
  }
}
