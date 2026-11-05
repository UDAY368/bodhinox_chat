// POST /api/platform/lifecycle (platform admins only; MFA-recent, CSRF-checked) -
//   { accountId, status: 'active' | 'admin_suspended', blockManual?: boolean, reason (10..1000) }.
//   Suspends or reactivates a workspace and blocks or allows manual replies. Writes both audit
//   trails and notifies the workspace's owners and admins. Inbound messages, opt-outs and payment
//   webhooks keep working. 200 { ok: true }; 400 invalid; 404 unknown workspace; 409 the
//   workspace is closing (its owner's deletion request).

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { changeLifecycle, parseLifecycleChange } from '@/lib/platform/lifecycle';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin(request, { mutation: true });
    const change = parseLifecycleChange(await request.json().catch(() => null));
    if (!change) return NextResponse.json({ error: 'invalid', code: 'invalid' }, { status: 400, headers: noStore });
    await changeLifecycle(admin, change);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
