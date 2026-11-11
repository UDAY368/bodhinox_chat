// GET /api/conversations/{id}/handling — every member, viewers included.
//   Who handled this conversation, newest first:
//   200 { events: [{ id, kind, from, to, actor, at }] } where kind is
//   assigned | unassigned | resolved | reopened, and from / to / actor are
//   { id, name } (name null for a former member) or null (actor null: done
//   automatically). 404 when the conversation is not visible to the member
//   (another workspace's id, or another agent's chat under assigned_or_team).
//   Read-only; the log is written only by the database.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { tenantOf } from '@/lib/audience/http';
import { conversationHandlingHistory, ConversationNotFoundError } from '@/lib/inbox/handling-history';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await context.params;
    const events = await conversationHandlingHistory(tenantOf(ctx), id);
    return NextResponse.json({ events }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ConversationNotFoundError)
      return NextResponse.json({ error: getT('Inbox.history')('notFound'), code: 'not_found' }, { status: 404, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
