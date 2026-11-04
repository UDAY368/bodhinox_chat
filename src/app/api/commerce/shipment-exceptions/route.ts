// GET /api/commerce/shipment-exceptions?status=open|resolved&limit= — courier
// shipments that need a person: a tracking contradiction after a final state,
// return to origin, lost or damaged, a courier claim the order disagrees with,
// an ambiguous create or AWB, stale tracking. Admin and above with
// commerce.shipments. 200 { exceptions } (ids, codes, AWB and our reference only).

import { NextResponse } from 'next/server';

import { withTenant } from '@/lib/db/tenant';
import { listShipmentExceptions } from '@/lib/fulfilment/exceptions';
import { ShipmentError } from '@/lib/fulfilment/types';
import { NO_STORE, shipmentAdmin, shipmentErrorResponse } from './_lib/http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const actor = await shipmentAdmin();
    const params = new URL(request.url).searchParams;
    const status = params.get('status') || 'open';
    if (status !== 'open' && status !== 'resolved') throw new ShipmentError('invalid');
    const limit = Number(params.get('limit') ?? 50);
    const exceptions = await withTenant(actor, (tx) => listShipmentExceptions(tx, actor.accountId, {
      status, limit: Number.isFinite(limit) ? limit : 50,
    }));
    return NextResponse.json({ exceptions }, { headers: NO_STORE });
  } catch (error) {
    return shipmentErrorResponse(error);
  }
}
