// /api/account/deletion: workspace deletion request (Phase 14).
//   GET     the workspace lifecycle (any member): status, requested at, purge after.
//   POST    { currentPassword?, mfaCode? } requests deletion: owner only, password (or a
//           recent Google sign-in) plus the authenticator when the owner has MFA. Sends
//           stop for the 30-day grace period; nothing is deleted (purge is not built).
//   DELETE  cancels a pending request (owner).

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { assertMutation, requireSession } from '@/lib/auth/session';
import {
  AccountActionError,
  accountActionResponse,
  cancelWorkspaceDeletion,
  getWorkspaceLifecycle,
  requestWorkspaceDeletion,
} from '@/lib/account/deletion';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const body = z
  .object({ currentPassword: z.string().min(1).max(1024).optional(), mfaCode: z.string().min(1).max(100).optional() })
  .strict();

const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    return NextResponse.json({ lifecycle: await getWorkspaceLifecycle(session) }, { headers: noStore });
  } catch (error) {
    return accountActionResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = checkRateLimit(`account:deletion:${session.userId}`, { limit: 5, windowMs: 60 * 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new AccountActionError('invalid_request', 400);
    const { billingCancel, ...lifecycle } = await requestWorkspaceDeletion(session, {
      password: parsed.data.currentPassword,
      mfaCode: parsed.data.mfaCode,
    });
    return NextResponse.json({ lifecycle, billingCancel }, { headers: noStore });
  } catch (error) {
    return accountActionResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    return NextResponse.json({ lifecycle: await cancelWorkspaceDeletion(session) }, { headers: noStore });
  } catch (error) {
    return accountActionResponse(error);
  }
}
