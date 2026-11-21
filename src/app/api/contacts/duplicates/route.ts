// GET /api/contacts/duplicates?cursor=&limit= (admins and owners)
//   One page of likely duplicate contact pairs (src/lib/contacts/duplicates.ts):
//   200 { pairs: [{ reasons, contacts: [a, b] }], next_cursor }; 400 invalid_request; 401; 403 forbidden.
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { DuplicatesError, findDuplicates } from '@/lib/contacts/duplicates';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin'))
      return NextResponse.json({ error: 'forbidden', code: 'forbidden' }, { status: 403, headers: NO_STORE });
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const page = await findDuplicates({ accountId: session.accountId, userId: session.userId, role: session.role }, {
      cursor: url.searchParams.get('cursor'), limit: Number.isFinite(limit) ? limit : 20,
    });
    return NextResponse.json({ pairs: page.pairs, next_cursor: page.nextCursor }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof DuplicatesError)
      return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
