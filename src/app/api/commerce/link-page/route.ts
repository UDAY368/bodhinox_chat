// GET /api/commerce/link-page: the link-in-bio page settings and the products it can feature (agents and above). 200 { page }.
// PUT /api/commerce/link-page { enabled, bio, links: [{ label, url }], featured_product_ids }: save them (admins). Links are plain http(s)
//   URLs, at most 12; at most 6 featured products. 400 { code: 'invalid', field }.

import { NextResponse } from 'next/server';
import { getLinkPage, saveLinkPage } from '@/lib/commerce/link-page';
import { parseLinkPage } from '@/lib/commerce/link-page-rules';
import { readBody, readerOf, writerOf } from '@/lib/commerce/marketing-http';
import { storeErrorResponse } from '@/lib/commerce/store-settings';

export async function GET() {
  try {
    return NextResponse.json({ page: await getLinkPage(await readerOf()) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const caller = await writerOf('link-page');
    if ('response' in caller) return caller.response;
    return NextResponse.json({ page: await saveLinkPage(caller.staff, parseLinkPage(await readBody(request))) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
