// POST /api/commerce/email-campaigns/<id>/send: queue the campaign (admins). The recipients and their jobs are saved before this answers;
//   calling it again only queues what is missing. 200 { campaign }; 409 { code } email_not_connected | sender_details_required | no_recipients |
//   too_many_recipients | campaign_locked (cancelled).

import { NextResponse } from 'next/server';
import { sendCampaign } from '@/lib/commerce/email-campaigns';
import { writerOf } from '@/lib/commerce/marketing-http';
import { storeErrorResponse } from '@/lib/commerce/store-settings';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await writerOf('email-send');
    if ('response' in caller) return caller.response;
    return NextResponse.json({ campaign: await sendCampaign(caller.staff, (await params).id) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
