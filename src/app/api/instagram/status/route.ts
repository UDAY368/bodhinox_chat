// GET /api/instagram/status — any member. Always 200:
//   { enabled: false, reason, accounts: [] }  while Instagram is off or not configured
//   { enabled: true, appId, humanAgentEnabled, accounts }  otherwise
// accounts are the workspace's Instagram accounts without any token column
// (the app role holds column grants only). Never calls Instagram.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { instagramStatus } from '@/lib/instagram/config';
import { listInstagramAccounts } from '@/lib/instagram/connection';
import { actorOf, NO_STORE, routeError } from '../_lib/route';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const status = instagramStatus();
    const accounts = status.enabled ? await listInstagramAccounts(actorOf(session)) : [];
    return NextResponse.json({ ...status, accounts }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
