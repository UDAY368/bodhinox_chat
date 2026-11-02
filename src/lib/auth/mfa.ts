import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { getAuthPrisma } from '@/lib/db/prisma';
import { hashToken } from './csrf';
import { AuthError } from './errors';
import type { AuthTransaction } from './service';
import type { AuthContext } from './session';
import { verifyPassword } from './password';

function key(): Buffer {
  const configured = process.env.AUTH_MFA_ENCRYPTION_KEY;
  if (!configured || !/^[a-f0-9]{64}$/i.test(configured))
    throw new Error('AUTH_MFA_ENCRYPTION_KEY must be a random 32-byte hex key');
  return Buffer.from(configured, 'hex');
}
export function encryptMfaSecret(secret: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('hex'),
    encrypted.toString('hex'),
    cipher.getAuthTag().toString('hex'),
  ].join(':');
}
export function decryptMfaSecret(value: string): string {
  const [iv, encrypted, tag] = value
    .split(':')
    .map((v) => Buffer.from(v, 'hex'));
  if (!iv || iv.length !== 12 || !tag || tag.length !== 16)
    throw new Error('Invalid encrypted MFA factor');
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8'
  );
}
type Factor = {
  id: string;
  secret_encrypted: string;
  verified_at: Date | null;
  last_used_step: bigint | null;
  recovery_hashes: string[];
};
async function consumeCode(
  tx: AuthTransaction,
  factor: Factor,
  code: string
): Promise<void> {
  if (/^\d{6}$/.test(code)) {
    const result = await verify({
      secret: decryptMfaSecret(factor.secret_encrypted),
      token: code,
      epochTolerance: [30, 0],
      ...(factor.last_used_step === null
        ? {}
        : { afterTimeStep: Number(factor.last_used_step) }),
    });
    if (result.valid && 'timeStep' in result) {
      await tx.$executeRaw`UPDATE auth_mfa_factors SET last_used_step=${BigInt(result.timeStep!)} WHERE id=${factor.id}::uuid`;
      return;
    }
  } else if (
    code.length <= 100 &&
    factor.verified_at &&
    factor.recovery_hashes.includes(hashToken(code.trim().toUpperCase()))
  ) {
    await tx.$executeRaw`UPDATE auth_mfa_factors SET recovery_hashes=array_remove(recovery_hashes,${hashToken(code.trim().toUpperCase())}) WHERE id=${factor.id}::uuid`;
    return;
  }
  throw new AuthError(
    'Invalid or already used authentication code',
    401,
    'mfa_invalid'
  );
}
export async function checkMfa(
  tx: AuthTransaction,
  userId: string,
  code?: string
): Promise<boolean> {
  const factors = await tx.$queryRaw<
    Factor[]
  >`SELECT * FROM auth_mfa_factors WHERE user_id=${userId}::uuid AND verified_at IS NOT NULL FOR UPDATE`;
  if (!factors[0]) return false;
  if (!code)
    throw new AuthError(
      'Enter your authenticator or recovery code',
      401,
      'mfa_required'
    );
  await consumeCode(tx, factors[0], code);
  return true;
}
async function confirmPassword(
  tx: AuthTransaction,
  context: AuthContext,
  password: string
): Promise<void> {
  const rows = await tx.$queryRaw<
    { password_hash: string }[]
  >`SELECT password_hash FROM auth_users WHERE id=${context.userId}::uuid FOR UPDATE`;
  if (!rows[0] || !(await verifyPassword(rows[0].password_hash, password)))
    throw new AuthError(
      'Current password is incorrect',
      401,
      'current_password_invalid'
    );
}
/** A Google sign-in this recent, on the same session, confirms enrolment for an account without a password. */
export const GOOGLE_REAUTH_MINUTES = 10;
/**
 * Enrolment needs the current password. An account created through Google that never set a
 * password cannot give one, so for it (and only it) the current session must come from a Google
 * sign-in in the last GOOGLE_REAUTH_MINUTES minutes instead.
 */
async function confirmEnrolment(
  tx: AuthTransaction,
  context: AuthContext,
  password: string | undefined
): Promise<void> {
  const rows = await tx.$queryRaw<
    { password_set: boolean }[]
  >`SELECT password_set FROM auth_users WHERE id=${context.userId}::uuid FOR UPDATE`;
  if (!rows[0] || rows[0].password_set)
    return confirmPassword(tx, context, password ?? '');
  const fresh = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM auth_sessions WHERE id=${context.sessionId}::uuid AND user_id=${context.userId}::uuid
      AND sign_in_method='google' AND revoked_at IS NULL AND expires_at>NOW()
      AND created_at>NOW()-${GOOGLE_REAUTH_MINUTES}*INTERVAL '1 minute'`;
  if (!fresh[0])
    throw new AuthError(
      'Sign in with Google again to confirm it is you, then set up two-step verification',
      401,
      'google_reauth_required'
    );
}
/** Whether the user has a password of their own (false for an account created through Google). */
export async function hasOwnPassword(context: AuthContext): Promise<boolean> {
  const rows = await getAuthPrisma().$queryRaw<
    { password_set: boolean }[]
  >`SELECT password_set FROM auth_users WHERE id=${context.userId}::uuid`;
  return rows[0]?.password_set ?? true;
}
export async function enrollMfa(
  context: AuthContext,
  password: string | undefined
): Promise<{ secret: string; uri: string }> {
  const secret = generateSecret(),
    encrypted = encryptMfaSecret(secret);
  await getAuthPrisma().$transaction(async (tx) => {
    await confirmEnrolment(tx, context, password);
    const factors = await tx.$queryRaw<
      Factor[]
    >`SELECT * FROM auth_mfa_factors WHERE user_id=${context.userId}::uuid FOR UPDATE`;
    if (factors[0]?.verified_at)
      throw new AuthError('MFA is already enabled', 409);
    await tx.$executeRaw`INSERT INTO auth_mfa_factors(id,user_id,secret_encrypted,recovery_hashes)
      VALUES(${randomUUID()}::uuid,${context.userId}::uuid,${encrypted},ARRAY[]::text[])
      ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=EXCLUDED.secret_encrypted,last_used_step=NULL,created_at=NOW()`;
  });
  return {
    secret,
    uri: generateURI({ issuer: 'Bodhinox', label: context.user.email, secret }),
  };
}
function recoveryCodes(): string[] {
  return Array.from({ length: 10 }, () =>
    randomBytes(10).toString('hex').toUpperCase()
  );
}
export async function verifyMfaEnrollment(
  context: AuthContext,
  code: string
): Promise<string[]> {
  const codes = recoveryCodes();
  await getAuthPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${context.userId}::uuid FOR UPDATE`;
    const rows = await tx.$queryRaw<
      Factor[]
    >`SELECT * FROM auth_mfa_factors WHERE user_id=${context.userId}::uuid AND created_at>NOW()-INTERVAL '10 minutes' FOR UPDATE`;
    if (!rows[0] || rows[0].verified_at)
      throw new AuthError('Start MFA enrollment first', 400);
    await consumeCode(tx, rows[0], code);
    await tx.$executeRaw`UPDATE auth_mfa_factors SET verified_at=NOW(),recovery_hashes=${codes.map(hashToken)}::text[] WHERE id=${rows[0].id}::uuid`;
    await tx.$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=${context.userId}::uuid AND id<>${context.sessionId}::uuid`;
    await tx.$executeRaw`UPDATE auth_sessions SET mfa_verified_at=NOW() WHERE id=${context.sessionId}::uuid AND revoked_at IS NULL`;
  });
  return codes;
}
export async function disableMfa(
  context: AuthContext,
  password: string,
  code: string
): Promise<void> {
  await getAuthPrisma().$transaction(async (tx) => {
    await confirmPassword(tx, context, password);
    if (!(await checkMfa(tx, context.userId, code)))
      throw new AuthError('MFA is not enabled', 400);
    await tx.$executeRaw`DELETE FROM auth_mfa_factors WHERE user_id=${context.userId}::uuid`;
    await tx.$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=${context.userId}::uuid`;
  });
}
export async function getMfaStatus(context: AuthContext): Promise<boolean> {
  const rows = await getAuthPrisma().$queryRaw<
    { id: string }[]
  >`SELECT id FROM auth_mfa_factors WHERE user_id=${context.userId}::uuid AND verified_at IS NOT NULL`;
  return !!rows[0];
}
