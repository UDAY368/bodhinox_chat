// GET /api/instagram/ref-links (Stage 3) — any member:
//   { links: [{ flowId, flowName, flowStatus, key, instagramAccountId, username, url }] }
// The ref links the workspace's ig_ref flows listen on (src/lib/instagram/ref-link-list.ts).
// Read-only: a link is created by creating the flow, whose own routes carry the
// admin/CSRF checks. 503 instagram_not_enabled while Instagram is off; another
// workspace's flows and accounts are never listed.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { instagramConfig } from '@/lib/instagram/config';
import { notEnabledResponse } from '@/lib/instagram/http';
import { listRefLinks } from '@/lib/instagram/ref-link-list';
import { actorOf, NO_STORE, routeError } from '../_lib/route';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    return NextResponse.json({ links: await listRefLinks(actorOf(session)) }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
