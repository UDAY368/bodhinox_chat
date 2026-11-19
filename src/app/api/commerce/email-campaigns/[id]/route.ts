// GET /api/commerce/email-campaigns/<id>: one campaign (agents and above). 200 { campaign }.
// PATCH /api/commerce/email-campaigns/<id> { name, subject, body, segment_id? }: edit a draft (admins); 409 campaign_locked once queued.

import { NextResponse } from 'next/server';
import { getCampaign, updateCampaign } from '@/lib/commerce/email-campaigns';
import { parseCampaignInput } from '@/lib/commerce/email-rules';
import { readBody, readerOf, writerOf } from '@/lib/commerce/marketing-http';
import { storeErrorResponse } from '@/lib/commerce/store-settings';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    return NextResponse.json({ campaign: await getCampaign(await readerOf(), (await params).id) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const caller = await writerOf('email-campaigns');
    if ('response' in caller) return caller.response;
    return NextResponse.json({ campaign: await updateCampaign(caller.staff, (await params).id, parseCampaignInput(await readBody(request))) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
