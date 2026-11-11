// GET /api/instagram/home (Stage 5, 5F) — any member: the Instagram home page
// summary (the last 7 days, the account defaults and the next moves), see
// src/lib/instagram/home-summary.ts. Read-only. 503 instagram_not_enabled while
// Instagram is off; the summary always runs as the caller's own workspace.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramHomeSummary } from '@/lib/instagram/home-summary';
import { notEnabledResponse } from '@/lib/instagram/http';
import { actorOf, NO_STORE, routeError } from '../_lib/route';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    return NextResponse.json({ summary: await instagramHomeSummary(actorOf(session)) }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
