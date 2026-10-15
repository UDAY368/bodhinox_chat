import { getWorkerPrisma } from '@/lib/db/prisma';
import { ContractError } from '@/lib/data/contracts';

/** The worker credential can invoke only these fixed routing functions before
 * tenant resolution. Resolved domain reads still require a tenant transaction. */
export async function resolveWhatsAppAccount(
  phoneNumberId: string
): Promise<string | null> {
  if (!/^\d{1,32}$/.test(phoneNumberId))
    throw new ContractError('Invalid provider phone number ID');
  const rows = await getWorkerPrisma().$queryRawUnsafe<
    { account_id: string | null }[]
  >(
    'SELECT crm_resolve_whatsapp_account($1::text) AS account_id',
    phoneNumberId
  );
  return rows[0]?.account_id ?? null;
}
export async function resolveWabaAccount(
  wabaId: string
): Promise<string | null> {
  if (!/^\d{1,32}$/.test(wabaId))
    throw new ContractError('Invalid provider business account ID');
  const rows = await getWorkerPrisma().$queryRawUnsafe<
    { account_id: string | null }[]
  >('SELECT crm_resolve_waba_account($1::text) AS account_id', wabaId);
  return rows[0]?.account_id ?? null;
}
export interface RoutedApiKey {
  id: string;
  account_id: string;
  scopes: string[];
  revoked_at: Date | null;
  expires_at: Date | null;
  created_by: string | null;
}
export async function resolveApiKey(
  keyHash: string
): Promise<RoutedApiKey | null> {
  if (!/^[a-f0-9]{64}$/i.test(keyHash))
    throw new ContractError('Invalid API key digest');
  const rows = await getWorkerPrisma().$queryRawUnsafe<RoutedApiKey[]>(
    'SELECT * FROM crm_resolve_api_key($1::text)',
    keyHash
  );
  return rows[0] ?? null;
}
export async function verifyWebhookTokenHash(
  tokenHash: string
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return false;
  const rows = await getWorkerPrisma().$queryRawUnsafe<{ valid: boolean }[]>(
    'SELECT crm_verify_webhook_token($1::text) AS valid',
    tokenHash
  );
  return rows[0]?.valid === true;
}
