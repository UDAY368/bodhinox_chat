import {
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from 'jose';
import { randomUUID } from 'node:crypto';

export const ACCESS_LIFETIME_SECONDS = 15 * 60;
export interface AccessClaims extends JWTPayload {
  sub: string;
  tenant_id: string;
  sid: string;
  jti: string;
  token_use: 'access';
  iat: number;
  exp: number;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing authentication configuration: ${name}`);
  return value.replace(/\\n/g, '\n');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function signAccessToken(context: {
  userId: string;
  accountId: string;
  sessionId: string;
}): Promise<string> {
  const key = await importPKCS8(required('AUTH_JWT_PRIVATE_KEY'), 'RS256');
  return new SignJWT({
    tenant_id: context.accountId,
    sid: context.sessionId,
    token_use: 'access',
  })
    .setProtectedHeader({
      alg: 'RS256',
      typ: 'JWT',
      kid: required('AUTH_JWT_KID'),
    })
    .setSubject(context.userId)
    .setIssuer(required('AUTH_JWT_ISSUER'))
    .setAudience(required('AUTH_JWT_AUDIENCE'))
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_LIFETIME_SECONDS}s`)
    .sign(key);
}
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload, protectedHeader } = await jwtVerify(
    token,
    async (header) => {
      if (header.kid === required('AUTH_JWT_KID'))
        return importSPKI(required('AUTH_JWT_PUBLIC_KEY'), 'RS256');
      const keys = JSON.parse(
        process.env.AUTH_JWT_VERIFICATION_KEYS ?? '{}'
      ) as Record<string, { publicKey: string; expiresAt: string }>;
      const retiring =
        typeof header.kid === 'string' && Object.hasOwn(keys, header.kid)
          ? keys[header.kid]
          : null;
      const expiry = retiring ? new Date(retiring.expiresAt).getTime() : NaN;
      if (
        !retiring ||
        !Number.isFinite(expiry) ||
        expiry <= Date.now() ||
        expiry > Date.now() + ACCESS_LIFETIME_SECONDS * 1000
      )
        throw new Error('Unknown or expired signing key');
      return importSPKI(retiring.publicKey.replace(/\\n/g, '\n'), 'RS256');
    },
    {
      algorithms: ['RS256'],
      issuer: required('AUTH_JWT_ISSUER'),
      audience: required('AUTH_JWT_AUDIENCE'),
      requiredClaims: [
        'sub',
        'iat',
        'exp',
        'tenant_id',
        'sid',
        'jti',
        'token_use',
      ],
      maxTokenAge: '15m',
      clockTolerance: 0,
    }
  );
  if (
    protectedHeader.typ !== 'JWT' ||
    payload.token_use !== 'access' ||
    typeof payload.sub !== 'string' ||
    !uuid.test(payload.sub) ||
    typeof payload.tenant_id !== 'string' ||
    !uuid.test(payload.tenant_id) ||
    typeof payload.sid !== 'string' ||
    !uuid.test(payload.sid) ||
    typeof payload.jti !== 'string' ||
    !uuid.test(payload.jti) ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > ACCESS_LIFETIME_SECONDS
  ) {
    throw new Error('Invalid access token claims');
  }
  return payload as AccessClaims;
}
