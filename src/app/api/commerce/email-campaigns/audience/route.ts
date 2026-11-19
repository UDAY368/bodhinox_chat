// GET /api/commerce/email-campaigns/audience?segment_id=<id>: how many contacts an audience has, how many have an email address and
//   how many may be emailed now (agents and above). No segment_id: every contact. 200 { audience: { audience, withEmail, eligible, unsubscribed } }.

import { NextResponse } from 'next/server';
import { previewCampaignAudience } from '@/lib/commerce/email-campaigns';
import { readerOf } from '@/lib/commerce/marketing-http';
import { isUuid, storeErrorResponse, StoreError } from '@/lib/commerce/store-settings';

export async function GET(request: Request) {
  try {
    const ctx = await readerOf();
    const segment = new URL(request.url).searchParams.get('segment_id');
    if (segment !== null && !isUuid(segment)) throw new StoreError('invalid', { field: 'segment_id' });
    return NextResponse.json({ audience: await previewCampaignAudience(ctx, segment) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
