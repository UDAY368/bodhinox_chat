import { beforeAll, describe, expect, it } from 'vitest';
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { signAccessToken, verifyAccessToken } from './jwt';

let privateKey: CryptoKey;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(keys.publicKey);
  process.env.AUTH_JWT_KID = 'unit-key';
  process.env.AUTH_JWT_ISSUER = 'https://auth.example.test';
  process.env.AUTH_JWT_AUDIENCE = 'bodhinox';
});

const claims = {
  userId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
};
describe('access JWT validation', () => {
  it('signs with RS256 and bounds access to 15 minutes', async () => {
    const token = await signAccessToken(claims);
    const payload = await verifyAccessToken(token);
    expect(payload.sub).toBe(claims.userId);
    expect(payload.sid).toBe(claims.sessionId);
    expect(payload.tenant_id).toBe(claims.accountId);
    expect(payload.jti).toMatch(/^[a-f0-9-]{36}$/);
    expect(payload.exp! - payload.iat!).toBe(900);
  });
  it('rejects expiry, wrong issuer/audience, missing session, and wrong key identifier', async () => {
    for (const variant of ['expired', 'issuer', 'audience', 'session', 'kid']) {
      const token = await new SignJWT({
        tenant_id: claims.accountId,
        ...(variant === 'session' ? {} : { sid: claims.sessionId }),
        token_use: 'access',
      })
        .setProtectedHeader({
          alg: 'RS256',
          kid: variant === 'kid' ? 'other' : 'unit-key',
          typ: 'JWT',
        })
        .setSubject(claims.userId)
        .setJti(claims.userId)
        .setIssuer(
          variant === 'issuer' ? 'other' : process.env.AUTH_JWT_ISSUER!
        )
        .setAudience(variant === 'audience' ? 'other' : 'bodhinox')
        .setIssuedAt()
        .setExpirationTime(variant === 'expired' ? '-1s' : '15m')
        .sign(privateKey);
      await expect(verifyAccessToken(token)).rejects.toThrow();
    }
  });
  it('rejects a modified signature', async () => {
    const token = await signAccessToken(claims);
    const parts = token.split('.');
    parts[2] = `${parts[2][0] === 'a' ? 'b' : 'a'}${parts[2].slice(1)}`;
    await expect(verifyAccessToken(parts.join('.'))).rejects.toThrow();
  });
  it('accepts retiring keys only inside the configured bounded overlap', async () => {
    const oldKid = process.env.AUTH_JWT_KID!,
      oldPublic = process.env.AUTH_JWT_PUBLIC_KEY!;
    const token = await signAccessToken(claims);
    const next = await generateKeyPair('RS256', { extractable: true });
    process.env.AUTH_JWT_KID = 'rotated-key';
    process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(next.publicKey);
    process.env.AUTH_JWT_VERIFICATION_KEYS = JSON.stringify({
      [oldKid]: {
        publicKey: oldPublic,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    });
    expect((await verifyAccessToken(token)).sub).toBe(claims.userId);
    process.env.AUTH_JWT_VERIFICATION_KEYS = JSON.stringify({
      [oldKid]: {
        publicKey: oldPublic,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    await expect(verifyAccessToken(token)).rejects.toThrow();
    process.env.AUTH_JWT_VERIFICATION_KEYS = JSON.stringify({
      [oldKid]: {
        publicKey: oldPublic,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    await expect(verifyAccessToken(token)).rejects.toThrow();
    process.env.AUTH_JWT_KID = oldKid;
    process.env.AUTH_JWT_PUBLIC_KEY = oldPublic;
    delete process.env.AUTH_JWT_VERIFICATION_KEYS;
  });
  it('rejects algorithm substitutions and JWTs without a unique token identifier', async () => {
    const payload = {
      tenant_id: claims.accountId,
      sid: claims.sessionId,
      token_use: 'access',
    };
    const noId = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'unit-key', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(process.env.AUTH_JWT_ISSUER!)
      .setAudience('bodhinox')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);
    await expect(verifyAccessToken(noId)).rejects.toThrow();
    const hmac = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', kid: 'unit-key', typ: 'JWT' })
      .setSubject(claims.userId)
      .setJti(claims.userId)
      .setIssuer(process.env.AUTH_JWT_ISSUER!)
      .setAudience('bodhinox')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new Uint8Array(32));
    await expect(verifyAccessToken(hmac)).rejects.toThrow();
  });
});
