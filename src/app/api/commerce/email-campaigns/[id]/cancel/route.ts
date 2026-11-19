// POST /api/commerce/email-campaigns/<id>/cancel: stop a campaign (admins); recipients still waiting are skipped. 200 { campaign }.

import { NextResponse } from 'next/server';
import { cancelCampaign } from '@/lib/commerce/email-campaigns';
import { writerOf } from '@/lib/commerce/marketing-http';
import { storeErrorResponse } from '@/lib/commerce/store-settings';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await writerOf('email-send');
    if ('response' in caller) return caller.response;
    return NextResponse.json({ campaign: await cancelCampaign(caller.staff, (await params).id) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
