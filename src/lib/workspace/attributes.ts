// ============================================================
// Workspace (global) attributes: account-wide key/value pairs used as
// {{workspace.key}} in flow and automation text. Secret values are
// stored encrypted, never returned to the browser, and only resolved
// for automation webhook steps — never into customer messages.
// ============================================================

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

export interface WorkspaceAttribute {
  key: string;
  /** null for secrets: the value is write-only. */
  value: string | null;
  is_secret: boolean;
  updated_at: string;
}

/** Invalid attribute input; the message is safe to show (HTTP 400). */
export class AttributeError extends Error {}

export const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const inputSchema = z.object({
  key: z.string().regex(ATTRIBUTE_KEY, 'Keys use lowercase letters, numbers and _, start with a letter, and are at most 40 characters'),
  value: z.string().min(1, 'Enter a value').max(1000, 'Values are at most 1,000 characters'),
  is_secret: z.boolean().optional(),
}).strict();

const COLUMNS = Prisma.sql`key, CASE WHEN is_secret THEN NULL ELSE value END AS value, is_secret, updated_at`;

export function listAttributes(ctx: TenantContext): Promise<WorkspaceAttribute[]> {
  return withTenant(ctx, (tx) =>
    tx.$queryRaw<WorkspaceAttribute[]>`SELECT ${COLUMNS} FROM workspace_attributes WHERE account_id=${ctx.accountId}::uuid ORDER BY key`,
  );
}

/** Create or replace one attribute (admin+, enforced by RLS too). */
export async function saveAttribute(ctx: TenantContext, input: unknown): Promise<WorkspaceAttribute> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AttributeError(parsed.error.issues[0]?.message ?? 'Invalid attribute');
  const { key, value, is_secret: secret = false } = parsed.data;
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<WorkspaceAttribute[]>`
      INSERT INTO workspace_attributes(account_id,key,value,value_encrypted,is_secret)
      VALUES(${ctx.accountId}::uuid,${key},${secret ? null : value},${secret ? encrypt(value) : null},${secret})
      ON CONFLICT (account_id,key) DO UPDATE SET value=EXCLUDED.value, value_encrypted=EXCLUDED.value_encrypted, is_secret=EXCLUDED.is_secret
      RETURNING ${COLUMNS}`;
    return rows[0];
  });
}

/** Returns false when the key does not exist in this account. */
export async function deleteAttribute(ctx: TenantContext, key: string): Promise<boolean> {
  if (!ATTRIBUTE_KEY.test(key)) return false;
  return withTenant(ctx, async (tx) =>
    (await tx.$executeRaw`DELETE FROM workspace_attributes WHERE account_id=${ctx.accountId}::uuid AND key=${key}`) > 0,
  );
}

/** Values for {{workspace.key}}. Secrets are included (decrypted) only when asked. */
export async function workspaceValues(accountId: string, { secrets = false } = {}): Promise<Record<string, string>> {
  const rows = await withTenant({ accountId }, (tx) => tx.$queryRaw<{ key: string; value: string | null; value_encrypted: string | null }[]>`
    SELECT key, value, value_encrypted FROM workspace_attributes WHERE account_id=${accountId}::uuid`);
  const values: Record<string, string> = {};
  for (const row of rows) {
    if (row.value !== null) values[row.key] = row.value;
    else if (secrets && row.value_encrypted) values[row.key] = decrypt(row.value_encrypted);
  }
  return values;
}

/** workspaceValues, but only queried when `text` uses a placeholder, so plain messages cost nothing. */
export async function workspaceValuesFor(accountId: string, text: string, options?: { secrets?: boolean }): Promise<Record<string, string>> {
  return /\{\{\s*workspace\./.test(text) ? workspaceValues(accountId, options) : {};
}

/** Replace {{workspace.key}} placeholders; unknown keys render as empty, like {{vars.*}}. */
export function fillWorkspace(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*workspace\.([a-z][a-z0-9_]*)\s*\}\}/g, (_, key: string) => (Object.hasOwn(values, key) ? values[key] : ''));
}
