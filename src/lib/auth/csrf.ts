import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ForbiddenError } from './errors';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
export function appOrigin(): string {
  const value = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!value) throw new Error('APP_URL must be configured for authentication');
  const url = new URL(value);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new Error('Production APP_URL requires HTTPS');
  return url.origin;
}
export function assertOrigin(request: Request): void {
  if (request.headers.get('origin') !== appOrigin())
    throw new ForbiddenError('Invalid request origin');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    throw new ForbiddenError('Cross-site mutation denied');
}
export function assertCsrf(request: Request, expectedHash: string): void {
  const supplied = request.headers.get('x-csrf-token');
  if (
    !supplied ||
    supplied.length > 256 ||
    !/^[a-f0-9]{64}$/.test(expectedHash)
  )
    throw new ForbiddenError('Invalid CSRF token');
  const actual = Buffer.from(hashToken(supplied), 'hex');
  if (!timingSafeEqual(actual, Buffer.from(expectedHash, 'hex')))
    throw new ForbiddenError('Invalid CSRF token');
}
