// PATCH /api/commerce/referrals/<id> { active?, commission_bps? }: switch a code off or on, or change an affiliate's commission (admins). 200 { ok: true }.

import { NextResponse } from 'next/server';
import { parseCodePatch, updateReferralCode } from '@/lib/commerce/referrals';
import { readBody, writerOf } from '@/lib/commerce/marketing-http';
import { storeErrorResponse } from '@/lib/commerce/store-settings';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await writerOf('referrals');
    if ('response' in caller) return caller.response;
    await updateReferralCode(caller.staff, (await params).id, parseCodePatch(await readBody(request)));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
