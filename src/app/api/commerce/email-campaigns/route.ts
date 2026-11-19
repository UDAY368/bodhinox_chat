// GET /api/commerce/email-campaigns: the shop's email campaigns with how many recipients are in each state (agents and above).
// POST /api/commerce/email-campaigns { name, subject, body, segment_id? }: a draft (admins). 201 { campaign }.

import { NextResponse } from 'next/server';
import { createCampaign, listCampaigns } from '@/lib/commerce/email-campaigns';
import { parseCampaignInput } from '@/lib/commerce/email-rules';
import { readBody, readerOf, writerOf } from '@/lib/commerce/marketing-http';
import { storeErrorResponse } from '@/lib/commerce/store-settings';

export async function GET() {
  try {
    return NextResponse.json({ campaigns: await listCampaigns(await readerOf()) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const caller = await writerOf('email-campaigns');
    if ('response' in caller) return caller.response;
    return NextResponse.json({ campaign: await createCampaign(caller.staff, parseCampaignInput(await readBody(request))) }, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
