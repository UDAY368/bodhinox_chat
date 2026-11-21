import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { loadBusinessCards } from '@/lib/dashboard/business';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

// GET /api/dashboard/business: the Home revenue, bookings, ad spend and AI handled cards.
// Read-only; the role comes from the live membership and decides which figures are returned.
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const limit = await checkRateLimit(`dashboard:business:${ctx.accountId}:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const cards = await loadBusinessCards({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role });
    return NextResponse.json(cards, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return toErrorResponse(error); }
}
