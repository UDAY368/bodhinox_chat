import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import type { DataClient } from '@/lib/data/types';
import { hasMinRole, type AccountRole } from './roles';
import { requireSession } from './session';
import { AuthError, ForbiddenError } from './errors';
export { UnauthorizedError, ForbiddenError } from './errors';
export interface AccountContext {
  db: DataClient;
  userId: string;
  accountId: string;
  role: AccountRole;
  account: { id: string; name: string };
}
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status }
    );
  console.error(
    'Account context operation failed',
    error instanceof Error ? error.name : 'unknown'
  );
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
export async function getCurrentAccount(): Promise<AccountContext> {
  const session = await requireSession();
  const db = await createClient();
  const result = await db
    .from('accounts')
    .select('id,name')
    .eq('id', session.accountId)
    .maybeSingle();
  if (result.error || !result.data)
    throw new ForbiddenError('Workspace is unavailable');
  return {
    db,
    userId: session.userId,
    accountId: session.accountId,
    role: session.role,
    account: { id: result.data.id, name: result.data.name },
  };
}
export async function requireRole(
  minimum: AccountRole
): Promise<AccountContext> {
  const context = await getCurrentAccount();
  if (!hasMinRole(context.role, minimum))
    throw new ForbiddenError('Insufficient workspace role');
  return context;
}
