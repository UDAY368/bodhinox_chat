import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { keyMode } from './razorpay';

/**
 * Payment provider credentials. Secrets are encrypted at rest and the app role
 * cannot even SELECT the secret columns (column grants), so anything the app
 * client reads is safe to return to the browser. Secrets are read only here,
 * through the worker role, for a server-side provider call.
 */

/** What a member may see about a connected provider. Never contains secrets. */
export interface PaymentProviderPublic {
  id: string;
  provider: 'razorpay';
  mode: 'test' | 'live';
  key_id: string;
  connected_at: Date;
}

export class PaymentProviderError extends Error {
  constructor(public readonly reason: 'invalid_key' | 'not_connected') {
    super(reason === 'invalid_key' ? 'Invalid Razorpay key id' : 'Razorpay is not connected');
    this.name = 'PaymentProviderError';
  }
}

const publicSelect = { id: true, provider: true, mode: true, key_id: true, connected_at: true } as const;

/** The connected provider for members (any role), or null. `tx` is an app-role tenant transaction. */
export async function getPaymentProvider(tx: TenantTransaction, accountId: string): Promise<PaymentProviderPublic | null> {
  const row = await tx.payment_providers.findFirst({ where: { account_id: accountId, provider: 'razorpay' }, select: publicSelect });
  return (row as PaymentProviderPublic | null) ?? null;
}

/**
 * Connects or replaces Razorpay credentials. Admin only (RLS refuses others).
 * The mode follows the key id prefix. A missing `webhookSecret` keeps the
 * stored one. Test the credentials (razorpay.testCredentials) before calling.
 */
export async function savePaymentProvider(
  tx: TenantTransaction,
  accountId: string,
  input: { keyId: string; keySecret: string; webhookSecret?: string | null },
): Promise<PaymentProviderPublic> {
  const keyId = input.keyId.trim();
  const mode = keyMode(keyId);
  if (!mode || !input.keySecret) throw new PaymentProviderError('invalid_key');
  const keySecretEnc = encrypt(input.keySecret);
  const webhookSecretEnc = input.webhookSecret ? encrypt(input.webhookSecret) : null;
  const where = { account_id: accountId, provider: 'razorpay' };
  const data = {
    mode, key_id: keyId, key_secret_enc: keySecretEnc, connected_at: new Date(),
    ...(webhookSecretEnc ? { webhook_secret_enc: webhookSecretEnc } : {}),
  };
  const updated = await tx.payment_providers.updateMany({ where, data });
  if (updated.count === 0) {
    await tx.payment_providers.createMany({ data: [{ ...where, ...data }] });
  }
  const row = await getPaymentProvider(tx, accountId);
  if (!row) throw new PaymentProviderError('not_connected');
  return row;
}

/** Disconnects Razorpay. Admin only. */
export async function deletePaymentProvider(tx: TenantTransaction, accountId: string): Promise<boolean> {
  const { count } = await tx.payment_providers.deleteMany({ where: { account_id: accountId, provider: 'razorpay' } });
  return count > 0;
}

export interface RazorpaySecrets {
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
  mode: 'test' | 'live';
}

/** Decrypted Razorpay credentials for a server-side call. Never return or log the result. */
export async function loadRazorpaySecrets(accountId: string): Promise<RazorpaySecrets> {
  const row = await withTenant({ accountId, role: 'owner' }, (tx) => tx.payment_providers.findFirst({
    where: { account_id: accountId, provider: 'razorpay' },
    select: { key_id: true, key_secret_enc: true, webhook_secret_enc: true, mode: true },
  }), getWorkerPrisma());
  if (!row) throw new PaymentProviderError('not_connected');
  return {
    keyId: row.key_id,
    keySecret: decrypt(row.key_secret_enc),
    webhookSecret: row.webhook_secret_enc ? decrypt(row.webhook_secret_enc) : null,
    mode: row.mode as 'test' | 'live',
  };
}
