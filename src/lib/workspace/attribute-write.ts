// Workspace attribute writes from a flow's Actions step (Stage 5).
//
// A flow may change an existing, non-secret workspace attribute: set it, or
// add a number to it. A secret attribute (an API key) is never written from a
// flow, and a key the workspace does not have is not created here (admins
// create attributes in Settings). `increment` is one atomic UPDATE, so two runs
// adding at the same moment both count. Runs inside the caller's tenant
// transaction (the engine's worker transaction), so it can be committed
// together with the run's action cursor. Values are never logged.
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { parseNumberInput } from '@/lib/flows/input-formats';
import { ATTRIBUTE_KEY } from './attributes';

export const WORKSPACE_ATTRIBUTE_VALUE_MAX = 1000;

export type AttributeWriteResult = 'written' | 'secret' | 'missing' | 'invalid' | 'not_a_number';

/** The number to add, or null when `value` is not a plain decimal number. */
export function incrementBy(value: string): number | null {
  const n = parseNumberInput(value.trim());
  return n === null || !Number.isFinite(n) || Math.abs(n) > 1e12 ? null : n;
}

/** Sets or increments one non-secret workspace attribute. */
export async function writeWorkspaceAttribute(
  tx: TenantTransaction,
  accountId: string,
  input: { key: string; mode: 'set' | 'increment'; value: string },
): Promise<AttributeWriteResult> {
  if (!ATTRIBUTE_KEY.test(input.key) || typeof input.value !== 'string') return 'invalid';
  let updated: number;
  if (input.mode === 'set') {
    if (!input.value || input.value.length > WORKSPACE_ATTRIBUTE_VALUE_MAX) return 'invalid';
    updated = await tx.$executeRaw(Prisma.sql`UPDATE workspace_attributes SET value=${input.value}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND key=${input.key} AND NOT is_secret`);
  } else if (input.mode === 'increment') {
    const by = incrementBy(input.value);
    if (by === null) return 'invalid';
    // An empty or missing value counts as 0; a value that is not a number is left alone.
    updated = await tx.$executeRaw(Prisma.sql`UPDATE workspace_attributes
      SET value=trim_scale(COALESCE(NULLIF(btrim(value),''),'0')::numeric + ${by}::numeric)::text, updated_at=now()
      WHERE account_id=${accountId}::uuid AND key=${input.key} AND NOT is_secret
        AND COALESCE(NULLIF(btrim(value),''),'0') ~ '^-?[0-9]+(\\.[0-9]+)?$'`);
  } else {
    return 'invalid';
  }
  if (updated > 0) return 'written';
  const [row] = await tx.$queryRaw<{ is_secret: boolean }[]>(Prisma.sql`SELECT is_secret FROM workspace_attributes
    WHERE account_id=${accountId}::uuid AND key=${input.key}`);
  if (!row) return 'missing';
  return row.is_secret ? 'secret' : 'not_a_number';
}
