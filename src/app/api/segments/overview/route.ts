// GET /api/segments/overview (any member) — every saved segment with its live match count,
// how many may receive marketing, and up to four matching contacts' names (the Contacts >
// Segments tab). A segment whose tag, list, field or campaign was deleted has null counts.
import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { segmentCards } from '@/lib/audience/segments';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({ segments: await segmentCards(tenantOf(ctx)) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return audienceError(err);
  }
}
