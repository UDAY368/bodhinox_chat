// GET /api/commerce/marketing-settings: order confirmation email switch, sender details and the referral program (agents and above).
//   200 { settings } with email_connected: false when the platform SMTP is not configured (nothing is sent then).
// PUT /api/commerce/marketing-settings: replace them (admins). Same shape back; 400 { code: 'invalid', field }.

import { NextResponse } from 'next/server';
import { parseMarketingSettings } from '@/lib/commerce/email-rules';
import { getMarketingSettings, saveMarketingSettings } from '@/lib/commerce/marketing-settings';
import { readBody, readerOf, writerOf } from '@/lib/commerce/marketing-http';
import { storeErrorResponse } from '@/lib/commerce/store-settings';

export async function GET() {
  try {
    return NextResponse.json({ settings: await getMarketingSettings(await readerOf()) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const caller = await writerOf('marketing-settings');
    if ('response' in caller) return caller.response;
    return NextResponse.json({ settings: await saveMarketingSettings(caller.staff, parseMarketingSettings(await readBody(request))) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
