import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import {
  ContactTagWriteError,
  removeContactTag,
} from '@/lib/contacts/tag-write';
import { getT } from '@/lib/i18n/translate';
import { logContactActivity } from '@/lib/contacts/profile';

const t = getT('Api');

function tagWriteErrorResponse(error: ContactTagWriteError): NextResponse {
  return NextResponse.json({ error: error.message }, { status: error.status });
}

async function readTagId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as {
    tag_id?: unknown;
  } | null;
  return typeof body?.tag_id === 'string' && body.tag_id.trim()
    ? body.tag_id.trim()
    : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;
    const tagId = await readTagId(request);
    if (!tagId) {
      return NextResponse.json({ error: t('contacts.tagIdRequired') }, { status: 400 });
    }

    const result = await addContactTagAndDispatch({
      db: ctx.db,
      accountId: ctx.accountId,
      contactId,
      tagId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return tagWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;
    const tagId = await readTagId(request);
    if (!tagId) {
      return NextResponse.json({ error: t('contacts.tagIdRequired') }, { status: 400 });
    }

    const removed = await removeContactTag(ctx.db, {
      accountId: ctx.accountId,
      contactId,
      tagId,
    });
    // The contact's timeline (tag additions come from contact_tags itself). Best effort:
    // the tag is already removed, so a failed log must not fail the request.
    if (removed)
      await logContactActivity({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, contactId, 'tag_removed', { tag_id: tagId })
        .catch(() => console.error('[contacts] tag removal not added to the timeline'));

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return tagWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}
