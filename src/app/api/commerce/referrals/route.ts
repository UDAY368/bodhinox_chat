// GET /api/commerce/referrals: referral codes (customers' and affiliates') with what each brought in, and whether the program is on (agents and above).
//   200 { referrals: { enabled, currency, codes } }. The affiliate commission figures are a report only: nothing is paid out.
// POST /api/commerce/referrals { name, commission_bps }: a named affiliate with a code (admins), up to 200. 201 { affiliate: { id, code } }.

import { NextResponse } from 'next/server';
import { createAffiliate, listReferralCodes, parseAffiliate } from '@/lib/commerce/referrals';
import { readBody, readerOf, writerOf } from '@/lib/commerce/marketing-http';
import { storeErrorResponse } from '@/lib/commerce/store-settings';

export async function GET() {
  try {
    return NextResponse.json({ referrals: await listReferralCodes(await readerOf()) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const caller = await writerOf('referrals');
    if ('response' in caller) return caller.response;
    return NextResponse.json({ affiliate: await createAffiliate(caller.staff, parseAffiliate(await readBody(request))) }, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
