// POST /api/fulfilment/tracking/{accountId} — Shiprocket tracking pushes for
// one workspace (Phase 9, design D3, D4, §4). Public (no session).
//
// Shiprocket does not sign pushes; it sends the token the workspace generated
// as `x-api-key`. Only sha256(token) is stored; T4's courierWebhookTokenMatches
// compares digests in constant time. Not connected and a wrong token answer the
// same 401. A valid token always gets 200 (Shiprocket's guidance: answer only
// 200), including an unknown AWB or an unreadable body, which are ignored.
//
// The push is a hint only: nothing here changes a shipment or an order. The
// delivery is recorded once (webhook_receipts, minimised to {awb, code, ts})
// and a coalesced re-fetch job (shptrk:<shipmentId>) is queued in the same
// worker transaction before the 200; the job reads tracking back from
// Shiprocket with the workspace's own token. The shipment is resolved by AWB
// within this workspace only (the push's order_id is not ours to trust).
//
// The URL must not contain "shiprocket", "kartrocket", "sr" or "kr" (Shiprocket
// refuses it): this path has none and a UUID is hex; the hostname must not either.
// Bodies, tokens and AWBs are never logged.

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import { claimWebhookReceipt } from '@/lib/commerce/webhook-receipts';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { courierWebhookTokenMatches } from '@/lib/fulfilment/connection';
import { shiprocketDisabled } from '@/lib/fulfilment/shiprocket-client';
import { enqueueShipmentTrack, minimiseShiprocketPush } from '@/lib/fulfilment/tracking-job';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const MAX_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_\-.~+/=]{16,256}$/;
/** Per account, charged only for authenticated pushes (a stranger cannot spend a workspace's budget). */
const WEBHOOK_LIMIT = { limit: 300, windowMs: 60_000 };
/** Per client IP, charged only for failed or malformed authentication. */
const AUTH_FAIL_LIMIT = { limit: 30, windowMs: 60_000 };
const NO_STORE = { 'Cache-Control': 'private, no-store' };

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

const unauthorized = () => new Response('Unauthorized', { status: 401, headers: NO_STORE });

/** The rightmost x-forwarded-for hop (appended by the edge; client-sent hops to its left are ignored). */
function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map((hop) => hop.trim()).filter(Boolean).at(-1);
  return (forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown').slice(0, 64);
}

/** IPs whose failed-auth budget is spent, until the window resets (checked before the token lookup). */
const blockedUntil = new Map<string, number>();

function authBlocked(ip: string): { reset: number } | null {
  const until = blockedUntil.get(ip);
  if (until === undefined) return null;
  if (until > Date.now()) return { reset: until };
  blockedUntil.delete(ip);
  return null;
}

/** Charges one failed authentication to the IP; a 429 once its budget is spent, else the usual 401. */
function authFailed(ip: string): Response {
  const result = checkRateLimit(`shipmentTrackingAuthFail:${ip}`, AUTH_FAIL_LIMIT);
  if (result.success) return unauthorized();
  if (blockedUntil.size > 10_000) {
    const now = Date.now();
    for (const [key, until] of blockedUntil) if (until <= now) blockedUntil.delete(key);
  }
  blockedUntil.set(ip, result.reset);
  return rateLimitResponse(result);
}
const ok = () => NextResponse.json({ ok: true }, { headers: NO_STORE });

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await context.params;
  // An unknown account looks exactly like a wrong token.
  // Authentication first: the per-workspace budget is charged only for pushes carrying that workspace's token.
  const ip = clientIp(request);
  const blocked = authBlocked(ip);
  if (blocked) return rateLimitResponse({ success: false, remaining: 0, reset: blocked.reset, limit: AUTH_FAIL_LIMIT.limit });
  const token = request.headers.get('x-api-key')?.trim() ?? '';
  if (!UUID.test(accountId) || !TOKEN.test(token)) return authFailed(ip);

  let matches: boolean;
  try {
    matches = await courierWebhookTokenMatches(accountId, token);
  } catch {
    return new Response('Unavailable', { status: 500, headers: NO_STORE });
  }
  if (!matches) return authFailed(ip);
  const limit = checkRateLimit(`shipmentTracking:${accountId}`, WEBHOOK_LIMIT);
  if (!limit.success) return rateLimitResponse(limit);
  // Kill switch: acknowledged, nothing queued (no provider call can follow).
  if (shiprocketDisabled()) return ok();

  const raw = await readBody(request);
  if (raw === null) return ok();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return ok(); }
  const push = minimiseShiprocketPush(parsed);
  if (!push) return ok();

  const digest = createHash('sha256').update(`${push.awb}|${push.code ?? ''}|${push.ts ?? ''}`).digest('hex');
  try {
    await withTenant({ accountId }, async (tx) => {
      const [shipment] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM order_shipments
        WHERE account_id=${accountId}::uuid AND awb=${push.awb} AND create_state='created'`;
      if (!shipment) return; // Not ours (another workspace's AWB, or one we never created): ignored.
      const receipt = await claimWebhookReceipt(tx, { provider: 'shiprocket', receiptId: `${accountId}:${digest}`, payload: push });
      if (receipt.duplicate) return;
      await enqueueShipmentTrack(tx, accountId, shipment.id);
    }, getWorkerPrisma());
  } catch {
    // Not acknowledged, so Shiprocket may deliver it again; the poll sweep catches up either way.
    return new Response('Unavailable', { status: 500, headers: NO_STORE });
  }
  return ok();
}
