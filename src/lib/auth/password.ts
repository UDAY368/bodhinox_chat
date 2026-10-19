import { hash, verify, argon2id } from 'argon2';
import { AuthError } from './errors';
import { meetsPasswordRequirements, PASSWORD_REQUIREMENTS } from './password-policy';

export function validatePassword(password: string): void {
  if (
    !meetsPasswordRequirements(password)
  )
    throw new AuthError(
      PASSWORD_REQUIREMENTS,
      400,
      'weak_password'
    );
}
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}
export async function verifyPassword(
  encoded: string,
  password: string
): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') > 1024
  )
    return false;
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
}
