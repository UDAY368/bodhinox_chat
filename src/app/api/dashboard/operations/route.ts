import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { loadDashboardOperations } from '@/lib/dashboard/operations';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`dashboard:operations:${ctx.accountId}:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const days = Number(new URL(request.url).searchParams.get('days') ?? 7);
    if (![7, 30, 90].includes(days)) return NextResponse.json({ error: 'Unsupported overview range' }, { status: 400 });
    const overview = await loadDashboardOperations({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, days);
    return NextResponse.json(overview, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return toErrorResponse(error); }
}
