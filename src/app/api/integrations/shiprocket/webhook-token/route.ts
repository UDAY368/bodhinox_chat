// POST /api/integrations/shiprocket/webhook-token — generates a new tracking webhook token (admin +
//   commerce.shipments). 200 { token } once: only its sha256 digest is stored, so it cannot be shown
//   again; the previous token stops working immediately. 503 not_connected when Shiprocket is not connected.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { rotateWebhookToken } from '@/lib/fulfilment/connection';
import { actorOf, errorResponse, NO_STORE, writeLimit } from '../_lib/http';

export const runtime = 'nodejs';

export async function POST() {
  try {
    const ctx = await requireRole('admin');
    const limited = writeLimit('shiprocketSettings', ctx.userId);
    if (limited) return limited;
    const { token } = await rotateWebhookToken(actorOf(ctx));
    return NextResponse.json({ token }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
