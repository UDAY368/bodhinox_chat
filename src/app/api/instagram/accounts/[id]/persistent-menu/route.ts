// /api/instagram/accounts/{id}/persistent-menu — an Instagram account's
// persistent menu (Stage 3, 3D).
//   GET -> { menu: { instagramAccountId, managed, syncedAt, items: [{ type, title, flowId | url, flowName, flowUsable }] } }
//        any member.
//   PUT { items: [{ type: 'postback', title, flow_id } | { type: 'web_url', title, url }] } (0-20) -> { menu }
//        admin, Origin + CSRF, rate limited. Sets the menu on Instagram first, then stores it; an empty list removes it.
// 400 invalid_request (bad list, an http link, or a flow that is not an
// Instagram flow of this workspace); 404 not_found (also another workspace's
// id); 409 token, permission or disconnected; 429 rate limited or a concurrent
// save; 502 meta_error; 503 while off.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { getPersistentMenu, MAX_MENU_ITEMS, MAX_MENU_TITLE_CHARS, setPersistentMenuItems } from '@/lib/instagram/persistent-menu';
import { actorOf, adminMutation, isUuid, NO_STORE, readJson, routeError } from '../../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** Shape only; the service trims, counts characters, checks the link and the flows. */
const Title = z.string().max(MAX_MENU_TITLE_CHARS * 4);
const Body = z.object({
  items: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('postback'), title: Title, flow_id: z.string().max(64) }).strict(),
    z.object({ type: z.literal('web_url'), title: Title, url: z.string().max(2048) }).strict(),
  ])).max(MAX_MENU_ITEMS),
}).strict();

export async function GET(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    return NextResponse.json({ menu: await getPersistentMenu(actorOf(session), id) }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'persistentMenu');
    if (session instanceof NextResponse) return session;
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    const parsed = Body.safeParse(await readJson(request));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const menu = await setPersistentMenuItems(actorOf(session), id, parsed.data.items.map((item) =>
      item.type === 'postback' ? { type: item.type, title: item.title, flowId: item.flow_id } : item));
    return NextResponse.json({ menu }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
