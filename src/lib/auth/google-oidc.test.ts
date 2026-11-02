import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/db/prisma', () => ({ getAuthPrisma: vi.fn() }));
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import {
  beginGoogleFlow,
  completeGoogleFlow,
  googleConfig,
  openCookie,
  pkceChallenge,
  resetGoogleCaches,
  sealCookie,
  verifyGoogleIdToken,
  type FlowState,
} from './google-oidc';

const config = { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'secret-xyz' };
const discovery = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
};
let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] });
});
beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://crm.test');
  resetGoogleCaches();
});
afterEach(() => vi.unstubAllEnvs());

function idToken(claims: Record<string, unknown>, options: { iss?: string; aud?: string; exp?: string } = {}) {
  return new SignJWT({ email: 'Person@Example.com', email_verified: true, nonce: 'n-1', name: 'Pat', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.iss ?? 'https://accounts.google.com')
    .setAudience(options.aud ?? config.clientId)
    .setSubject('1234567890')
    .setIssuedAt()
    .setExpirationTime(options.exp ?? '5m')
    .sign(privateKey);
}
const discoveryFetch = vi.fn(async () => Response.json(discovery)) as unknown as typeof fetch;

describe('Google configuration', () => {
  it('requires both the client id and secret', () => {
    expect(googleConfig({})).toBeNull();
    expect(googleConfig({ GOOGLE_CLIENT_ID: 'a' })).toBeNull();
    expect(googleConfig({ GOOGLE_CLIENT_ID: ' a ', GOOGLE_CLIENT_SECRET: 'b' })).toEqual({ clientId: 'a', clientSecret: 'b' });
  });
});

describe('sealed cookies', () => {
  it('round-trips, expires, and rejects tampering or a cookie sealed for another purpose', () => {
    const sealed = sealCookie('flow', { a: 1 }, 60, config, 1_000);
    expect(openCookie('flow', sealed, config, 2_000)).toMatchObject({ a: 1 });
    expect(openCookie('flow', sealed, config, 62_000)).toBeNull();
    expect(openCookie('mfa', sealed, config, 2_000)).toBeNull();
    expect(openCookie('flow', sealed, { ...config, clientSecret: 'other' }, 2_000)).toBeNull();
    const raw = Buffer.from(sealed, 'base64url');
    raw[14] ^= 1;
    expect(openCookie('flow', raw.toString('base64url'), config, 2_000)).toBeNull();
    expect(openCookie('flow', undefined, config)).toBeNull();
    expect(openCookie('flow', 'x'.repeat(5000), config)).toBeNull();
  });
});

describe('authorization request', () => {
  it('uses PKCE S256, state and nonce from the sealed cookie, and a local next path', async () => {
    const { url, cookie } = await beginGoogleFlow(
      { mode: 'signin', next: '//evil.example', invite: 'tok_1' },
      config,
      discoveryFetch
    );
    const flow = openCookie<FlowState>('flow', cookie, config)!;
    const params = new URL(url).searchParams;
    expect(url.startsWith(discovery.authorization_endpoint)).toBe(true);
    expect(params.get('client_id')).toBe(config.clientId);
    expect(params.get('redirect_uri')).toBe('https://crm.test/api/auth/google/callback');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBe(pkceChallenge(flow.verifier));
    expect(params.get('state')).toBe(flow.state);
    expect(params.get('nonce')).toBe(flow.nonce);
    expect(params.get('scope')).toBe('openid email profile');
    expect(url).not.toContain(flow.verifier);
    expect(flow).toMatchObject({ mode: 'signin', next: '/dashboard', invite: 'tok_1' });
  });
  it('refuses discovery documents that point away from Google', async () => {
    const bad = vi.fn(async () => Response.json({ ...discovery, token_endpoint: 'https://evil.example/token' })) as unknown as typeof fetch;
    await expect(beginGoogleFlow({ mode: 'signin' }, config, bad)).rejects.toMatchObject({ code: 'google_unavailable' });
  });
});

describe('ID token verification', () => {
  const expected = { clientId: config.clientId, nonce: 'n-1' };
  it('accepts a valid token and normalises the email', async () => {
    await expect(verifyGoogleIdToken(await idToken({}), expected, keys)).resolves.toEqual({
      subject: '1234567890',
      email: 'person@example.com',
      name: 'Pat',
    });
  });
  it.each([
    ['wrong audience', () => idToken({}, { aud: 'someone-else' })],
    ['wrong issuer', () => idToken({}, { iss: 'https://evil.example' })],
    ['expired', () => idToken({}, { exp: '-2h' })],
    ['wrong nonce', () => idToken({ nonce: 'n-2' })],
    ['unverified email', () => idToken({ email_verified: false })],
    ['string email_verified', () => idToken({ email_verified: 'true' })],
    ['foreign azp', () => idToken({ azp: 'another-client' })],
  ])('rejects %s', async (_label, make) => {
    await expect(verifyGoogleIdToken(await make(), expected, keys)).rejects.toMatchObject({ code: 'google_failed' });
  });
  it('rejects a token signed by another key', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ email: 'a@b.co', email_verified: true, nonce: 'n-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(config.clientId)
      .setSubject('1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(verifyGoogleIdToken(forged, expected, keys)).rejects.toMatchObject({ code: 'google_failed' });
  });
});

describe('callback completion', () => {
  const flow: FlowState = { state: 's-1', nonce: 'n-1', verifier: 'v-1', mode: 'signin', next: '/dashboard', invite: null };
  it('rejects a missing flow cookie or a mismatched state before calling Google', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(completeGoogleFlow(new URLSearchParams('state=s-1&code=c'), null, config, { fetchImpl, keys })).rejects.toMatchObject({ code: 'google_failed' });
    await expect(completeGoogleFlow(new URLSearchParams('state=s-2&code=c'), flow, config, { fetchImpl, keys })).rejects.toMatchObject({ code: 'google_failed' });
    await expect(completeGoogleFlow(new URLSearchParams('state=s-1&error=access_denied'), flow, config, { fetchImpl, keys })).rejects.toMatchObject({ code: 'google_cancelled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('redeems the code with the PKCE verifier and client secret, then verifies the ID token', async () => {
    const token = await idToken({});
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === discovery.token_endpoint) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('code_verifier')).toBe('v-1');
        expect(body.get('client_secret')).toBe(config.clientSecret);
        expect(body.get('code')).toBe('the-code');
        return Response.json({ id_token: token, access_token: 'unused' });
      }
      return Response.json(discovery);
    }) as unknown as typeof fetch;
    await expect(
      completeGoogleFlow(new URLSearchParams('state=s-1&code=the-code'), flow, config, { fetchImpl, keys })
    ).resolves.toMatchObject({ subject: '1234567890' });
  });
  it('treats Google 5xx and network failures as unavailable and 4xx as failed', async () => {
    const make = (status: number) =>
      vi.fn(async (url: string) =>
        url === discovery.token_endpoint ? Response.json({ error: 'x' }, { status }) : Response.json(discovery)
      ) as unknown as typeof fetch;
    await expect(completeGoogleFlow(new URLSearchParams('state=s-1&code=c'), flow, config, { fetchImpl: make(503), keys })).rejects.toMatchObject({ code: 'google_unavailable' });
    resetGoogleCaches();
    await expect(completeGoogleFlow(new URLSearchParams('state=s-1&code=c'), flow, config, { fetchImpl: make(400), keys })).rejects.toMatchObject({ code: 'google_failed' });
    resetGoogleCaches();
    const down = vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expect(completeGoogleFlow(new URLSearchParams('state=s-1&code=c'), flow, config, { fetchImpl: down, keys })).rejects.toMatchObject({ code: 'google_unavailable' });
  });
});
