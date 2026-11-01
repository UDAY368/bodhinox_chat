// ============================================================
// POST /api/v1/broadcasts/{id}/recipients — add a batch to an API
// campaign (scope: broadcasts:send). The campaign is created in the
// dashboard (Broadcasts → New API campaign) with its template.
//
// Body: { "recipients": [ { "to": "+14155550123", "params": ["Jane"] } ] }  (1..1000)
// Response (202): { "data": { "broadcast_id", "accepted", "rejected", "duplicates" } }
// Rejected: invalid numbers, opted-out/blocked contacts, missing template values.
// Duplicates: contacts already in this campaign (e.g. a retried batch) are not sent again.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { addApiCampaignRecipients } from '@/lib/broadcasts/api-campaign';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;
    if (!UUID.test(id)) return fail('not_found', 'Campaign not found', 404);
    const body = (await request.json().catch(() => null)) as { recipients?: unknown } | null;
    const recipients = Array.isArray(body?.recipients) ? body.recipients : [];
    const auditUserId = await resolveAuditUserId(ctx.db, ctx.accountId);
    const result = await addApiCampaignRecipients(ctx.db, ctx.accountId, auditUserId, id,
      recipients.map((r: { to?: unknown; params?: unknown }) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        params: Array.isArray(r?.params) ? r.params : undefined,
      })));
    return ok({ broadcast_id: id, ...result }, 202);
  } catch (err) {
    if (err instanceof BroadcastError) return fail(err.code, err.message, err.status);
    if (err instanceof ContactError) return fail(err.status === 400 ? 'bad_request' : 'internal', err.message, err.status);
    return toApiErrorResponse(err);
  }
}
