// ============================================================
// POST /api/v1/broadcasts — launch a template broadcast
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                 // optional label
//     "template_name": "promo_july",        // required, approved template
//     "template_language": "en_US",         // optional (default en_US)
//     "phone_number_id": "1234567890",      // optional Meta phone number id to send from (default: the workspace's default number)
//     "recipients": [                        // required, 1..1000
//       { "to": "+14155550123", "params": ["Jane"] },
//       { "to": "+14155550124" }
//     ]
//   }
//
// The broadcast, its recipient rows and the dispatch job commit together
// before the 202; the worker does the Meta fan-out. Poll
// `GET /api/v1/broadcasts/{id}` for progress.
//
// Response (202):
//   { "data": { "broadcast_id", "status": "sending",
//               "total_recipients", "accepted", "rejected" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  createBroadcast,
  BroadcastError,
} from '@/lib/whatsapp/broadcast-core';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    if (body.phone_number_id !== undefined && body.phone_number_id !== null && typeof body.phone_number_id !== 'string') {
      return fail('bad_request', "'phone_number_id' must be a string", 400);
    }
    const phoneNumberId = typeof body.phone_number_id === 'string' && body.phone_number_id.trim()
      ? body.phone_number_id.trim()
      : null;
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const auditUserId = await resolveAuditUserId(ctx.db, ctx.accountId);

    const plan = await createBroadcast(ctx.db, ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : null,
      phoneNumberId,
      recipients: recipients.map((r) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        params: Array.isArray(r?.params) ? r.params : undefined,
      })),
    });

    return ok(
      {
        broadcast_id: plan.broadcastId,
        status: 'sending',
        total_recipients: plan.planned.length,
        accepted: plan.planned.length,
        rejected: plan.rejected,
      },
      202
    );
  } catch (err) {
    if (err instanceof BroadcastError) {
      return fail(err.code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
