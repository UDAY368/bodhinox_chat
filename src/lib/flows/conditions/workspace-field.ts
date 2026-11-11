// The `workspace_field` condition subject (Stage 5): the value of a
// non-secret workspace attribute of the run's workspace. A secret attribute,
// or a key the workspace does not have, reads as undefined (missing), so a
// condition can never test a secret's value.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { ATTRIBUTE_KEY } from '@/lib/workspace/attributes';

export async function workspaceFieldSubject(accountId: string, key: string): Promise<string | undefined> {
  if (!ATTRIBUTE_KEY.test(key)) return undefined;
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ value: string | null }[]>(Prisma.sql`
    SELECT value FROM workspace_attributes WHERE account_id=${accountId}::uuid AND key=${key} AND NOT is_secret`), getWorkerPrisma());
  const value = rows[0]?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}
