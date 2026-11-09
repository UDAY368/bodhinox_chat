// POST /api/platform/health/jobs/{id}/requeue (platform admins only, recent MFA, origin checked) -
//   body { reason (3-1000 chars) }. Puts one failed job back in the queue to run now with a fresh
//   attempt budget; audited in the platform and workspace audit trails. A job whose provider
//   outcome is uncertain is refused: it needs reconciliation, not a blind re-run.
//   200 { requeued: true }; 400 reason_required; 404 not_found; 409 not_failed / needs_reconciliation.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { requeueFailedJob } from '@/lib/platform/health';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request, { mutation: true });
    const { id } = await context.params;
    await requeueFailedJob(admin, id, await request.json().catch(() => null));
    return NextResponse.json({ requeued: true }, { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
