/**
 * Tenant-scoped storage for the WhatsApp Forms data endpoint. Meta calls the
 * endpoint without a session, so these run as the worker role (as the webhook
 * processor does) scoped to the account named in the endpoint URL. The private
 * key is returned decrypted to the caller only; it is never logged or sent out.
 */

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { decrypt } from '@/lib/whatsapp/encryption';

import type { FormAnswers, FormsSessionStore } from './endpoint';

/** Tenant-scoped worker access, the same privilege the webhook processor runs with. */
function inAccount<T>(accountId: string, operation: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId, role: 'owner' }, operation, getWorkerPrisma());
}

export async function formsPrivateKey(accountId: string): Promise<string | null> {
  return (await formsPrivateKeys(accountId))[0] ?? null;
}

/**
 * The keys the endpoint may decrypt with: the current key, then the key of a
 * rotation that Meta may already hold but that was never promoted (a save that
 * failed after the upload). Unreadable keys are skipped.
 */
export async function formsPrivateKeys(accountId: string): Promise<string[]> {
  const rows = await inAccount(accountId, (tx) => tx.$queryRaw<{ forms_private_key_enc: string | null; forms_pending_private_key_enc: string | null }[]>`
    SELECT forms_private_key_enc, forms_pending_private_key_enc FROM whatsapp_config
    WHERE account_id = ${accountId}::uuid LIMIT 1`);
  const row = rows[0];
  if (!row) return [];
  const keys: string[] = [];
  for (const value of [row.forms_private_key_enc, row.forms_pending_private_key_enc]) {
    if (!value) continue;
    try { keys.push(decrypt(value)); } catch { /* unreadable key: skip */ }
  }
  return keys;
}

export function formsSessionStore(accountId: string): FormsSessionStore {
  return {
    async find(flowToken) {
      const rows = await inAccount(accountId, (tx) => tx.$queryRaw<{ id: string; answers: FormAnswers; expired: boolean; completed: boolean; definition: unknown }[]>`
        SELECT s.id, s.answers, s.expires_at <= now() AS expired, s.completed_at IS NOT NULL AS completed, f.definition
        FROM whatsapp_form_sessions s
        JOIN whatsapp_forms f ON f.account_id = s.account_id AND f.id = s.form_id
        WHERE s.account_id = ${accountId}::uuid AND s.flow_token = ${flowToken} LIMIT 1`);
      return rows[0] ?? null;
    },
    async saveAnswers(sessionId, values) {
      await inAccount(accountId, (tx) => tx.$executeRaw`
        UPDATE whatsapp_form_sessions SET answers = answers || ${JSON.stringify(values)}::jsonb
        WHERE account_id = ${accountId}::uuid AND id = ${sessionId}::uuid AND completed_at IS NULL`);
    },
    async complete(sessionId, values) {
      // completed_at IS NULL makes a duplicate final submission a no-op.
      const rows = await inAccount(accountId, (tx) => tx.$queryRaw<{ answers: FormAnswers }[]>`
        UPDATE whatsapp_form_sessions SET answers = answers || ${JSON.stringify(values)}::jsonb, completed_at = now()
        WHERE account_id = ${accountId}::uuid AND id = ${sessionId}::uuid AND completed_at IS NULL AND expires_at > now()
        RETURNING answers`);
      return rows[0]?.answers ?? null;
    },
  };
}
