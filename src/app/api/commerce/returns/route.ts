// GET /api/commerce/returns?status=&page= — the workspace's returns queue, newest first, 25 a page (agents and above;
//   viewers get 403). status: open (requested, received or inspected) | requested | received | inspected | closed | rejected;
//   none = every return. 200 { returns: ReturnQueueItem[], total }; 400 for a bad status or page.
//   Each row names its order; the order sheet handles the return's actions (POST /api/commerce/returns/[id]).

import { NextResponse } from 'next/server';

import { listReturnQueue, parseReturnQueueQuery } from '@/lib/commerce/returns-queue';
import { lifecycleErrorResponse, NO_STORE, staffContext } from '../orders/_lib/http';

export async function GET(request: Request) {
  try {
    const ctx = await staffContext();
    const query = parseReturnQueueQuery(new URL(request.url).searchParams);
    return NextResponse.json(await listReturnQueue(ctx, query), { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
