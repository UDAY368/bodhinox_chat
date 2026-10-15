import { hash, verify, argon2id } from 'argon2';
import { AuthError } from './errors';

export function validatePassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < 12 ||
    Buffer.byteLength(password, 'utf8') > 1024
  )
    throw new AuthError(
      'Use a password of at least 12 characters',
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
