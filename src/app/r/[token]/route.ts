// GET /r/<token> — public campaign link: record the click, then 302 to the
// campaign's stored HTTPS destination. Unknown tokens get a plain 404.

import { NextResponse } from 'next/server';
import { clickDestination, recordClick } from '@/lib/broadcasts/clicks';
import { checkRateLimit } from '@/lib/rate-limit';

const CLICK_RECORD_LIMIT = { limit: 5, windowMs: 60_000 };
import { TEST_CLICK_TOKEN } from '@/lib/broadcasts/tracking';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (token === TEST_CLICK_TOKEN)
    return new NextResponse('This is a test message link. Real recipients are taken to the campaign page and their clicks are counted.', { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  try {
    // Repeated hits still redirect, but only a bounded number are recorded.
    const record = checkRateLimit(`click:${token}:${ip ?? 'unknown'}`, CLICK_RECORD_LIMIT).success;
    const destination = record ? await recordClick(token, ip) : await clickDestination(token);
    if (!destination) return new NextResponse('Link not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.redirect(destination, { status: 302, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch {
    console.error('[click] redirect failed');
    return new NextResponse('Link temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
