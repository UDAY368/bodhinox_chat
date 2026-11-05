// /api/account/export: workspace export (Phase 14, Settings -> Privacy & access).
//   GET  the latest exports (owners and admins).
//   POST { mfaCode? } requests one: owners and admins only, the authenticator (or a
//        recovery code) when the user has MFA. The row and its job commit together;
//        409 export_in_progress while one is queued or running, 503
//        storage_not_configured without private storage.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { assertMutation, requireSession } from '@/lib/auth/session';
import { accountActionResponse, AccountActionError } from '@/lib/account/deletion';
import { exportStorageConfigured, listWorkspaceExports, requestWorkspaceExport } from '@/lib/account/export';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const body = z.object({ mfaCode: z.string().min(1).max(100).optional() }).strict();

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    return NextResponse.json(
      { configured: exportStorageConfigured(), exports: await listWorkspaceExports(session) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return accountActionResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = checkRateLimit(`account:export:${session.userId}`, { limit: 5, windowMs: 60 * 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new AccountActionError('invalid_request', 400);
    const created = await requestWorkspaceExport(session, parsed.data);
    return NextResponse.json({ export: created }, { status: 202 });
  } catch (error) {
    return accountActionResponse(error);
  }
}
