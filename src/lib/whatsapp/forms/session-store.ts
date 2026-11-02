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

/** A private key the endpoint may decrypt with, and the WABAs of the numbers that hold it. */
export interface FormsKey {
  privateKeyPem: string;
  wabaIds: string[];
}

/**
 * The keys the endpoint may decrypt with. Meta encrypts each request with the
 * public key of the number the form was sent from, and the request does not say
 * which number that is until it is decrypted, so this returns every number's
 * keys in the account: each number's current key (default number first), then
 * the key of any rotation that Meta may already hold but that was never promoted
 * (a save that failed after the upload). Unreadable keys are skipped; a key held
 * by several numbers is returned once with all their WABAs. The endpoint then
 * only serves forms of a WABA whose number holds the key that decrypted it.
 */
export async function formsKeyring(accountId: string): Promise<FormsKey[]> {
  const rows = await inAccount(accountId, (tx) => tx.$queryRaw<{ forms_private_key_enc: string | null; forms_pending_private_key_enc: string | null; waba_id: string | null }[]>`
    SELECT forms_private_key_enc, forms_pending_private_key_enc, waba_id FROM whatsapp_config
    WHERE account_id = ${accountId}::uuid
      AND (forms_private_key_enc IS NOT NULL OR forms_pending_private_key_enc IS NOT NULL)
    ORDER BY is_default DESC, created_at ASC NULLS LAST, id ASC`);
  const keys: FormsKey[] = [];
  const add = (value: string | null, wabaId: string | null) => {
    if (!value) return;
    let privateKeyPem: string;
    try { privateKeyPem = decrypt(value); } catch { return; /* unreadable key: skip */ }
    let entry = keys.find((key) => key.privateKeyPem === privateKeyPem);
    if (!entry) keys.push(entry = { privateKeyPem, wabaIds: [] });
    if (wabaId && !entry.wabaIds.includes(wabaId)) entry.wabaIds.push(wabaId);
  };
  for (const row of rows) add(row.forms_private_key_enc, row.waba_id);
  for (const row of rows) add(row.forms_pending_private_key_enc, row.waba_id);
  return keys;
}

/** formsKeyring without the WABAs. */
export async function formsPrivateKeys(accountId: string): Promise<string[]> {
  return (await formsKeyring(accountId)).map((key) => key.privateKeyPem);
}

/**
 * `wabaIds`: the WABAs whose numbers hold the key that decrypted the request.
 * A session of a form in another WABA is then "not found" (427): one number's
 * key never opens another WABA's form. Omitted, every form of the account.
 * A form with no recorded WABA (never published) is not limited.
 */
export function formsSessionStore(accountId: string, scope?: { wabaIds: string[] }): FormsSessionStore {
  return {
    async find(flowToken) {
      const rows = await inAccount(accountId, (tx) => tx.$queryRaw<{ id: string; answers: FormAnswers; expired: boolean; completed: boolean; definition: unknown }[]>`
        SELECT s.id, s.answers, s.expires_at <= now() AS expired, s.completed_at IS NOT NULL AS completed, f.definition
        FROM whatsapp_form_sessions s
        JOIN whatsapp_forms f ON f.account_id = s.account_id AND f.id = s.form_id
        WHERE s.account_id = ${accountId}::uuid AND s.flow_token = ${flowToken}
          AND (${scope === undefined} OR f.waba_id IS NULL OR f.waba_id = ANY(${scope?.wabaIds ?? []}::text[]))
        LIMIT 1`);
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
