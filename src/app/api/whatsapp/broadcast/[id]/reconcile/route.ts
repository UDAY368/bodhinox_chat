import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  listUncertainRecipients,
  MAX_RECONCILE_BATCH,
  RECONCILE_RESOLUTIONS,
  ReconcileError,
  reconcileBroadcastRecipients,
  type ReconcileResolution,
} from '@/lib/broadcasts/reconcile';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: 'Broadcast unavailable' }, { status: 404 });

/**
 * GET /api/whatsapp/broadcast/[id]/reconcile
 *
 * The campaign's recipients whose send outcome is uncertain (at most 200,
 * oldest first) and their total. Needs campaigns.send.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await requireRole('agent');
    await requirePermission(tenantOf(caller), 'campaigns.send');
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const listed = await withTenant(tenantOf(caller), (tx) => listUncertainRecipients(tx, caller.accountId, id));
    return NextResponse.json(listed);
  } catch (error) {
    if (error instanceof ReconcileError) return notFound();
    return toErrorResponse(error);
  }
}

/**
 * POST /api/whatsapp/broadcast/[id]/reconcile  { recipientIds: string[], resolution: 'sent' | 'not_sent' }
 *
 * Staff record what Meta did with uncertain sends after checking: 'sent' marks
 * them sent (never resent), 'not_sent' makes them ordinary failures that the
 * next "Retry failed" sends again. Admin ceiling plus campaigns.send, a
 * CSRF-checked live session, 20 a minute per member; audited. Nothing is sent
 * by this route.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    const caller = await requireRole('admin');
    await requirePermission(tenantOf(caller), 'campaigns.send');
    const limit = checkRateLimit(`broadcast-reconcile:${caller.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const body = await request.json().catch(() => ({}));
    const resolution = body?.resolution as ReconcileResolution;
    const recipientIds: unknown = body?.recipientIds;
    if (!RECONCILE_RESOLUTIONS.includes(resolution) || !Array.isArray(recipientIds) || recipientIds.length === 0
      || recipientIds.length > MAX_RECONCILE_BATCH || !recipientIds.every((r) => typeof r === 'string' && UUID.test(r)))
      return NextResponse.json({ error: `Choose sent or not_sent for 1 to ${MAX_RECONCILE_BATCH} recipients` }, { status: 400 });
    const result = await withTenant(tenantOf(caller), (tx) => reconcileBroadcastRecipients(tx, {
      accountId: caller.accountId, userId: caller.userId, broadcastId: id, recipientIds: recipientIds as string[], resolution,
    }));
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ReconcileError) return notFound();
    return toErrorResponse(error);
  }
}
