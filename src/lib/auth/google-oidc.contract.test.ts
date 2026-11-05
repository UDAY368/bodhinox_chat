import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureFetch, loadProviderFixture, type ProviderFixture } from '@/test/fixtures/providers';
import { beginGoogleFlow, completeGoogleFlow, GoogleOidcError, resetGoogleCaches, type FlowState } from './google-oidc';

// Outbound contract for Google sign-in (design 1.4, P2): the documented discovery
// document and token responses replayed through the real client. The ID token is
// signed at test time with an in-process key; the corpus never holds a token.
const fx = (name: string) => loadProviderFixture('google', name);
const config = { clientId: 'fixture-client.apps.googleusercontent.com', clientSecret: 'test-only-secret' } as Parameters<typeof completeGoogleFlow>[2];
let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'fixture', alg: 'RS256' }] });
});
beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://crm.test');
  resetGoogleCaches();
});
afterEach(() => vi.unstubAllEnvs());

const flow: FlowState = { state: 'state-1', nonce: 'nonce-1', verifier: 'verifier-1', mode: 'signin', next: '/', invite: null };
const signed = () => new SignJWT({ email: 'Person@Example.com', email_verified: true, nonce: 'nonce-1', name: 'Pat' })
  .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer('https://accounts.google.com').setAudience(config.clientId)
  .setSubject('109876543210').setIssuedAt().setExpirationTime('5m').sign(privateKey);
async function tokenFixture(): Promise<ProviderFixture> {
  const f = fx('token-exchange');
  return { ...f, response: { ...f.response, body: { ...(f.response.body as object), id_token: await signed() } } };
}
const callback = new URLSearchParams({ state: 'state-1', code: 'fixture-code' });

describe('[TEN-03] Google OpenID Connect contract (docs-derived)', () => {
  it('builds the documented authorization request with PKCE from the discovery document', async () => {
    const fetch = fixtureFetch([fx('discovery')]);
    const { url } = await beginGoogleFlow({ mode: 'signin' }, config, fetch as unknown as typeof globalThis.fetch);
    expect(fetch.calls[0]).toMatchObject({ method: 'GET', url: fx('discovery').request!.path });
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({ client_id: config.clientId, redirect_uri: 'https://crm.test/api/auth/google/callback',
      response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256' });
  });

  it('redeems the code at the documented token endpoint and verifies the ID token', async () => {
    const fetch = fixtureFetch([fx('discovery'), await tokenFixture()]);
    const identity = await completeGoogleFlow(callback, flow, config, { fetchImpl: fetch as unknown as typeof globalThis.fetch, keys });
    expect(identity).toEqual({ subject: '109876543210', email: 'person@example.com', name: 'Pat' });
    const token = fetch.calls[1];
    expect(token.method).toBe('POST');
    expect(token.url).toBe(fx('token-exchange').request!.path);
    expect(token.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = Object.fromEntries(new URLSearchParams(token.body as string));
    expect(form).toMatchObject({ grant_type: 'authorization_code', code: 'fixture-code', client_id: config.clientId,
      redirect_uri: 'https://crm.test/api/auth/google/callback', code_verifier: 'verifier-1' });
  });

  it('maps invalid_grant to a failed sign-in and a 5xx to unavailable', async () => {
    const bad = fixtureFetch([fx('discovery'), fx('token-invalid-grant')]);
    await expect(completeGoogleFlow(callback, flow, config, { fetchImpl: bad as unknown as typeof globalThis.fetch, keys }))
      .rejects.toMatchObject({ code: 'google_failed' });
    resetGoogleCaches();
    const down = fixtureFetch([fx('discovery'), fx('token-unavailable')]);
    const error = await completeGoogleFlow(callback, flow, config, { fetchImpl: down as unknown as typeof globalThis.fetch, keys }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleOidcError);
    expect(error).toMatchObject({ code: 'google_unavailable' });
  });
});
