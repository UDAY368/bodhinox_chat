// Shared helpers for the shipment-exception routes (Phase 9, T5).

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import type { FulfilmentActor } from '@/lib/fulfilment/types';
import { ShipmentError } from '@/lib/fulfilment/types';
import { getT } from '@/lib/i18n/translate';

export const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** Admin and above with commerce.shipments (a restriction can turn it off for admins). */
export async function shipmentAdmin(): Promise<FulfilmentActor> {
  const ctx = await requireRole('admin');
  const actor = { ...tenantOf(ctx), userId: ctx.userId };
  await requirePermission(actor, 'commerce.shipments');
  return actor;
}

/** ShipmentError → its status and translated code; anything else → the generic account error response. */
export function shipmentErrorResponse(error: unknown): NextResponse {
  if (error instanceof ShipmentError) {
    const t = getT('Validation.shipments');
    return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status, headers: NO_STORE });
  }
  return toErrorResponse(error);
}
