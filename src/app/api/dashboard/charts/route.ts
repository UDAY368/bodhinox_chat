import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { CHART_RANGES, loadDashboardCharts } from '@/lib/dashboard/charts';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`dashboard:charts:${ctx.accountId}:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const days = Number(new URL(request.url).searchParams.get('days') ?? 30);
    if (!(CHART_RANGES as readonly number[]).includes(days)) return NextResponse.json({ error: 'Unsupported chart range' }, { status: 400 });
    const charts = await loadDashboardCharts({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, days);
    return NextResponse.json(charts, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return toErrorResponse(error); }
}
