// POST /api/integrations/zoom/webhook — the Zoom General app's one event
// notification endpoint (design D5). Public: authenticated only by
// x-zm-signature over the raw body with the app's webhook secret token. No
// session or CSRF applies (Zoom never sends a session cookie, so the proxy's
// mutation check does not run).
//
// Order of work: a 64 KB streamed cap; the signature verified before parsing;
// then the global and per-Zoom-account limits. No limit runs before the
// signature check, so unsigned traffic can never use up the budget real Zoom
// deliveries share (the cap and one HMAC are the only cost of a forged one). endpoint.url_validation is answered directly. The
// workspace is the live connection of payload.account_id (worker-only
// definer); an unknown account or an unsubscribed event is acknowledged and
// ignored. A verified delivery is recorded once (webhook_receipts, key
// sha256(raw)) and its meetings.zoom_event job queued in the same transaction
// before the 200; any failure is a 500 so Zoom redelivers. The job payload is
// ids and timestamps only. Bodies and secrets are never logged.
//
// Off by default: without the deployment's Zoom config this answers 503 and
// touches nothing.

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { claimWebhookReceipt } from '@/lib/commerce/webhook-receipts';
import { zoomConfig } from '@/lib/meetings/config';
import { ZOOM_EVENT_JOB } from '@/lib/meetings/types';
import { isZoomEvent, minimiseZoomEvent, urlValidationResponse, verifyZoomSignature } from '@/lib/meetings/webhook';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const MAX_BYTES = 64 * 1024;
/** Verified deliveries only: every tenant shares this endpoint; Zoom's own delivery rate stays far below it. */
const GLOBAL_LIMIT = { limit: 3000, windowMs: 60_000 };
const ACCOUNT_LIMIT = { limit: 600, windowMs: 60_000 };
const noStore = { 'Cache-Control': 'private, no-store' };

async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const ok = (body: unknown = { ok: true }) => NextResponse.json(body, { headers: noStore });
const text = (message: string, status: number) => new Response(message, { status, headers: noStore });

export async function POST(request: Request) {
  const config = zoomConfig();
  if (!config) return text('Zoom is not configured', 503);
  const raw = await readBody(request);
  if (raw === null) return text('Payload too large', 413);
  if (!verifyZoomSignature(raw, request.headers.get('x-zm-request-timestamp'), request.headers.get('x-zm-signature'), config.webhookSecretToken))
    return text('Invalid signature', 401);
  const global = checkRateLimit('zoomWebhook:global', GLOBAL_LIMIT);
  if (!global.success) return rateLimitResponse(global);

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return text('Invalid payload', 400); }
  const root = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!root) return text('Invalid payload', 400);

  if (root.event === 'endpoint.url_validation') {
    const payload = root.payload && typeof root.payload === 'object' ? (root.payload as Record<string, unknown>) : {};
    const plainToken = payload.plainToken;
    if (typeof plainToken !== 'string' || !plainToken || plainToken.length > 256) return text('Invalid payload', 400);
    return ok(urlValidationResponse(plainToken, config.webhookSecretToken));
  }

  const event = minimiseZoomEvent(body);
  if (!event || !isZoomEvent(event.event) || !event.zoomAccountId) return ok({ status: 'ignored' });
  const perAccount = checkRateLimit(`zoomWebhook:account:${event.zoomAccountId}`, ACCOUNT_LIMIT);
  if (!perAccount.success) return rateLimitResponse(perAccount);

  const receiptId = createHash('sha256').update(raw).digest('hex');
  try {
    const status = await getWorkerPrisma().$transaction(async (tx) => {
      const [tenant] = await tx.$queryRaw<{ account_id: string; connection_id: string }[]>`
        SELECT account_id::text AS account_id, connection_id::text AS connection_id FROM crm_resolve_zoom_connection(${event.zoomAccountId})`;
      if (!tenant) return 'ignored';
      const receipt = await claimWebhookReceipt(tx, { provider: 'zoom', receiptId, payload: { ...event, accountId: tenant.account_id } });
      if (receipt.duplicate) return 'duplicate';
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
        VALUES(${ZOOM_EVENT_JOB},${tenant.account_id}::uuid,${JSON.stringify({ ...event, connectionId: tenant.connection_id })}::jsonb,
          ${`zoom-event:${receiptId}`})
        ON CONFLICT(dedupe_key) DO NOTHING`;
      return 'queued';
    });
    return ok({ status });
  } catch {
    // Not acknowledged, so Zoom delivers it again.
    console.error('[zoom webhook] delivery could not be recorded');
    return text('Unavailable', 500);
  }
}
