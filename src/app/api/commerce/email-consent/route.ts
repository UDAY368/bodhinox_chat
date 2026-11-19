// POST /api/commerce/email-consent { attest: true, segment_id? }: an admin records that the customers of an audience (a segment, or every
//   contact) agreed to marketing email. Only contacts with an email address; one who unsubscribed is never given consent again.
//   200 { recorded }. 400 without attest: true.

import { NextResponse } from 'next/server';
import { recordEmailConsent } from '@/lib/commerce/email-campaigns';
import { readBody, writerOf } from '@/lib/commerce/marketing-http';
import { isUuid, storeErrorResponse, StoreError } from '@/lib/commerce/store-settings';

export async function POST(request: Request) {
  try {
    const caller = await writerOf('email-consent');
    if ('response' in caller) return caller.response;
    const body = await readBody(request) as Record<string, unknown> | null;
    if (!body || body.attest !== true) throw new StoreError('invalid', { field: 'attest' });
    if (body.segment_id !== undefined && body.segment_id !== null && !isUuid(body.segment_id)) throw new StoreError('invalid', { field: 'segment_id' });
    return NextResponse.json(await recordEmailConsent(caller.staff, typeof body.segment_id === 'string' ? body.segment_id.toLowerCase() : null));
  } catch (error) {
    return storeErrorResponse(error);
  }
}
