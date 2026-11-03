// /api/analytics/rate-card — the rate card for the settings editor.
//   GET any signed-in member: { cards, canEdit } (canEdit = platform admin, so
//       the editor knows whether to render).
//   PUT platform admins only; the same handler as /api/analytics/admin/rate-cards.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requireSession } from '@/lib/auth/session';
import { listRateCards } from '@/lib/analytics/rate-card';
import { isPlatformAdmin } from '@/lib/billing/prices';

export { PUT } from '../admin/rate-cards/route';

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const canEdit = isPlatformAdmin(session.user.email);
    return NextResponse.json({ cards: await listRateCards(), canEdit }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
