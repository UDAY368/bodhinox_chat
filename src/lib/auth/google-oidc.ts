/**
 * Google sign-in (OpenID Connect, Authorization Code + PKCE).
 *
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  OAuth client of type "Web application". Its
 *     authorised redirect URI must be `${APP_URL}/api/auth/google/callback`. When either is
 *     missing the login button is hidden and every Google route answers 503.
 *
 * Account rules:
 *   - A Google subject already linked to a user signs that user in (MFA still applies).
 *   - A verified Google email that matches an existing user is never linked automatically: the
 *     person signs in with their password and links Google from Settings → Login & security.
 *   - Otherwise a new verified user and workspace are created, under the same open, rate-limited
 *     signup policy as email signup (5 per address per hour, 100 per 15 minutes overall). When
 *     the flow started from an invitation link, the new user joins that workspace with the
 *     invited role instead, and no personal workspace is created; a used or expired link is
 *     refused (google_invite_unavailable) rather than creating one.
 * The flow cookie (state, nonce, PKCE verifier) and the pending-MFA cookie are AES-GCM sealed,
 * httpOnly and short-lived. Google tokens are never stored, logged or sent to the browser.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { getAuthPrisma } from '@/lib/db/prisma';
import { appOrigin, randomToken } from './csrf';
import { AuthError } from './errors';
import { hashPassword, verifyPassword } from './password';
import { safeNextPath } from './callback';
import {
  enforceAuthRateLimit,
  issueSession,
  joinInvitedWorkspace,
  lockOpenInvitation,
  type IssuedSession,
} from './service';
import type { AuthContext } from './session';

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const FLOW_TTL_SECONDS = 600;
const MFA_TTL_SECONDS = 300;
const TIMEOUT_MS = 15_000;

export type GoogleErrorCode =
  | 'google_unavailable'
  | 'google_cancelled'
  | 'google_failed'
  | 'google_link_required'
  | 'google_in_use'
  | 'google_already_linked'
  | 'google_no_workspace'
  | 'google_invite_unavailable'
  | 'google_rate_limited';
export class GoogleOidcError extends Error {
  constructor(readonly code: GoogleErrorCode) {
    super(code);
    this.name = 'GoogleOidcError';
  }
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}
export function googleConfig(
  env: Record<string, string | undefined> = process.env
): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
export function googleRedirectUri(): string {
  return `${appOrigin()}/api/auth/google/callback`;
}
export const googleCookieNames = () => ({
  flow: process.env.NODE_ENV === 'production' ? '__Host-bnx_google' : 'bnx_google',
  mfa: process.env.NODE_ENV === 'production' ? '__Host-bnx_google_mfa' : 'bnx_google_mfa',
});
export const googleCookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  // Lax: the callback is a top-level GET navigation from accounts.google.com.
  sameSite: 'lax' as const,
  path: '/',
  maxAge,
});
export { FLOW_TTL_SECONDS, MFA_TTL_SECONDS };

// ---------------------------------------------------------------- sealed cookies
function cookieKey(config: GoogleConfig): Buffer {
  return createHash('sha256')
    .update(`bodhinox:google-oidc-cookie:v1:${config.clientSecret}`)
    .digest();
}
export function sealCookie(
  purpose: 'flow' | 'mfa',
  payload: Record<string, unknown>,
  ttlSeconds: number,
  config: GoogleConfig,
  now = Date.now()
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(config), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ ...payload, exp: now + ttlSeconds * 1000 }), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}
export function openCookie<T extends Record<string, unknown>>(
  purpose: 'flow' | 'mfa',
  value: string | undefined,
  config: GoogleConfig,
  now = Date.now()
): T | null {
  if (!value || value.length > 4096) return null;
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', cookieKey(config), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const json = Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(json) as T & { exp?: number };
    if (typeof parsed.exp !== 'number' || parsed.exp <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- discovery and tokens
type Fetch = typeof fetch;
interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
let discoveryCache: { at: number; value: Promise<Discovery> } | null = null;
const jwksCache = new Map<string, JWTVerifyGetKey>();
function googleHost(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'accounts.google.com' || url.hostname.endsWith('.googleapis.com'))
    );
  } catch {
    return false;
  }
}
async function timed(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GoogleOidcError('google_unavailable');
  }
}
export async function googleDiscovery(fetchImpl: Fetch = fetch, now = Date.now()): Promise<Discovery> {
  if (discoveryCache && now - discoveryCache.at < 3600_000) return discoveryCache.value;
  const value = (async () => {
    const response = await timed(fetchImpl, DISCOVERY_URL);
    if (!response.ok) throw new GoogleOidcError('google_unavailable');
    const document = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !document ||
      document.issuer !== GOOGLE_ISSUERS[0] ||
      !googleHost(document.authorization_endpoint) ||
      !googleHost(document.token_endpoint) ||
      !googleHost(document.jwks_uri)
    )
      throw new GoogleOidcError('google_unavailable');
    return {
      authorization_endpoint: document.authorization_endpoint as string,
      token_endpoint: document.token_endpoint as string,
      jwks_uri: document.jwks_uri as string,
    };
  })();
  discoveryCache = { at: now, value };
  value.catch(() => {
    if (discoveryCache?.value === value) discoveryCache = null;
  });
  return value;
}
/** Test hook: forget cached discovery and key sets. */
export function resetGoogleCaches(): void {
  discoveryCache = null;
  jwksCache.clear();
}
function jwksFor(uri: string): JWTVerifyGetKey {
  let keys = jwksCache.get(uri);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(uri), { timeoutDuration: TIMEOUT_MS });
    jwksCache.set(uri, keys);
  }
  return keys;
}

export interface FlowState extends Record<string, unknown> {
  state: string;
  nonce: string;
  verifier: string;
  mode: 'signin' | 'link';
  next: string;
  invite: string | null;
  userId?: string;
  sessionId?: string;
}
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
export async function beginGoogleFlow(
  input: {
    mode: 'signin' | 'link';
    next?: string | null;
    invite?: string | null;
    userId?: string;
    sessionId?: string;
  },
  config: GoogleConfig,
  fetchImpl: Fetch = fetch
): Promise<{ url: string; cookie: string }> {
  const discovery = await googleDiscovery(fetchImpl);
  const flow: FlowState = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(),
    mode: input.mode,
    next: safeNextPath(input.next, input.mode === 'link' ? '/settings?tab=security' : undefined),
    invite: input.invite && /^[A-Za-z0-9_-]{1,512}$/.test(input.invite) ? input.invite : null,
    ...(input.mode === 'link' ? { userId: input.userId, sessionId: input.sessionId } : {}),
  };
  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: pkceChallenge(flow.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), cookie: sealCookie('flow', flow, FLOW_TTL_SECONDS, config) };
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  name: string;
}
export async function verifyGoogleIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  keys: JWTVerifyGetKey
): Promise<GoogleIdentity> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: GOOGLE_ISSUERS,
      audience: expected.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'iat', 'exp', 'nonce', 'email'],
      clockTolerance: 60,
    }));
  } catch {
    throw new GoogleOidcError('google_failed');
  }
  const nonce = typeof payload.nonce === 'string' ? Buffer.from(payload.nonce) : Buffer.alloc(0);
  const wanted = Buffer.from(expected.nonce);
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (
    nonce.length !== wanted.length ||
    !timingSafeEqual(nonce, wanted) ||
    payload.email_verified !== true ||
    (payload.azp !== undefined && payload.azp !== expected.clientId) ||
    typeof payload.sub !== 'string' ||
    payload.sub.length < 1 ||
    payload.sub.length > 255 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )
    throw new GoogleOidcError('google_failed');
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 200) : '';
  return { subject: payload.sub, email, name };
}

/** Validates state, redeems the code with the PKCE verifier and verifies the ID token. */
export async function completeGoogleFlow(
  params: URLSearchParams,
  flow: FlowState | null,
  config: GoogleConfig,
  deps: { fetchImpl?: Fetch; keys?: JWTVerifyGetKey } = {}
): Promise<GoogleIdentity> {
  if (!flow) throw new GoogleOidcError('google_failed');
  const state = Buffer.from(params.get('state') ?? '');
  const wanted = Buffer.from(flow.state);
  if (state.length !== wanted.length || !timingSafeEqual(state, wanted))
    throw new GoogleOidcError('google_failed');
  if (params.get('error')) throw new GoogleOidcError('google_cancelled');
  const code = params.get('code');
  if (!code || code.length > 2048) throw new GoogleOidcError('google_failed');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const discovery = await googleDiscovery(fetchImpl);
  const response = await timed(fetchImpl, discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: googleRedirectUri(),
      code_verifier: flow.verifier,
    }).toString(),
  });
  if (response.status >= 500) throw new GoogleOidcError('google_unavailable');
  const tokens = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!response.ok || typeof tokens?.id_token !== 'string')
    throw new GoogleOidcError('google_failed');
  return verifyGoogleIdToken(
    tokens.id_token,
    { clientId: config.clientId, nonce: flow.nonce },
    deps.keys ?? jwksFor(discovery.jwks_uri)
  );
}

// ---------------------------------------------------------------- accounts and sessions
/** The shared session issuer, with Google's error codes and audit action. */
function issueGoogleSession(
  userId: string,
  options: { mfaCode?: string; userAgent?: string | null }
): Promise<IssuedSession> {
  return issueSession(userId, {
    ...options,
    method: 'google',
    auditAction: 'auth.google_sign_in',
    refuseUser: () => new GoogleOidcError('google_failed'),
    refuseWorkspace: () => new GoogleOidcError('google_no_workspace'),
  });
}
async function hasMfa(userId: string): Promise<boolean> {
  const rows = await getAuthPrisma().$queryRaw<{ id: string }[]>`
    SELECT id FROM auth_mfa_factors WHERE user_id=${userId}::uuid AND verified_at IS NOT NULL`;
  return !!rows[0];
}
async function createGoogleUser(identity: GoogleIdentity, invite: string | null): Promise<string> {
  // Same policy as email signup: open, but rate limited per address and overall.
  try {
    await enforceAuthRateLimit('global-signup', 'application', 100, 900);
    await enforceAuthRateLimit('signup', identity.email, 5, 3600);
  } catch (error) {
    if (error instanceof AuthError && error.status === 429)
      throw new GoogleOidcError('google_rate_limited');
    throw error;
  }
  // No usable password (password_set=false): the person can set one later with "Forgot password";
  // until then a fresh Google sign-in stands in for the password when setting up two-step sign-in.
  const passwordHash = await hashPassword(`Aa1!${randomToken()}${randomToken()}`);
  const fullName = identity.name || identity.email.split('@')[0].slice(0, 200);
  const userId = randomUUID(),
    accountId = randomUUID();
  const created = await getAuthPrisma().$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at,password_set)
      VALUES(${userId}::uuid,${identity.email},${fullName},${passwordHash},NOW(),false)
      ON CONFLICT(email) DO NOTHING RETURNING id`;
    if (!inserted[0]) return false;
    if (invite) {
      let locked;
      try {
        locked = await lockOpenInvitation(tx, invite);
      } catch (error) {
        if (error instanceof AuthError) throw new GoogleOidcError('google_invite_unavailable');
        throw error;
      }
      await joinInvitedWorkspace(tx, locked, { id: userId, fullName, email: identity.email }, 'google');
      const joined = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO auth_identities(user_id,provider,subject,email) VALUES(${userId}::uuid,'google',${identity.subject},${identity.email})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!joined[0]) throw new GoogleOidcError('google_failed');
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${locked.account_id}::uuid,${userId}::uuid,'auth.google_signup',${userId},'{}'::jsonb)`;
      return true;
    }
    await tx.$executeRaw`SELECT set_config('app.user_id',${userId},true),set_config('app.account_id',${accountId},true),set_config('app.account_role','owner',true)`;
    await tx.$executeRaw`INSERT INTO accounts(id,name,owner_user_id) VALUES(${accountId}::uuid,${`${fullName}'s workspace`},${userId}::uuid)`;
    await tx.$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${accountId}::uuid,${userId}::uuid,'owner')`;
    await tx.$executeRaw`INSERT INTO profiles(id,user_id,full_name,email,account_id,account_role) VALUES(${randomUUID()}::uuid,${userId}::uuid,${fullName},${identity.email},${accountId}::uuid,'owner')`;
    const linked = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO auth_identities(user_id,provider,subject,email) VALUES(${userId}::uuid,'google',${identity.subject},${identity.email})
      ON CONFLICT DO NOTHING RETURNING id`;
    // A concurrent callback already created this Google subject: undo this attempt.
    if (!linked[0]) throw new GoogleOidcError('google_failed');
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${accountId}::uuid,${userId}::uuid,'auth.google_signup',${userId},'{}'::jsonb)`;
    return true;
  });
  if (!created) throw new GoogleOidcError('google_link_required');
  return userId;
}

export type GoogleSignInResult =
  | { kind: 'session'; session: IssuedSession; created: boolean; joinedInvite: boolean }
  | { kind: 'mfa'; userId: string };
export async function signInWithGoogle(
  identity: GoogleIdentity,
  userAgent: string | null,
  /** Invitation link token from the sign-in flow: a new identity joins that workspace. */
  invite: string | null = null
): Promise<GoogleSignInResult> {
  try {
    await enforceAuthRateLimit('google-login', identity.subject);
  } catch (error) {
    if (error instanceof AuthError && error.status === 429)
      throw new GoogleOidcError('google_rate_limited');
    throw error;
  }
  const linked = await getAuthPrisma().$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM auth_identities WHERE provider='google' AND subject=${identity.subject}`;
  let userId = linked[0]?.user_id;
  let created = false;
  if (userId) {
    await getAuthPrisma()
      .$executeRaw`UPDATE auth_identities SET email=${identity.email} WHERE provider='google' AND subject=${identity.subject}`;
  } else {
    const existing = await getAuthPrisma().$queryRaw<{ id: string }[]>`
      SELECT id FROM auth_users WHERE email=${identity.email}`;
    // Never link on an email match: sign in with the password, then link from settings.
    if (existing[0]) throw new GoogleOidcError('google_link_required');
    userId = await createGoogleUser(identity, invite);
    created = true;
  }
  if (await hasMfa(userId)) return { kind: 'mfa', userId };
  return {
    kind: 'session',
    session: await issueGoogleSession(userId, { userAgent }),
    created,
    joinedInvite: created && !!invite,
  };
}

export interface PendingMfa extends Record<string, unknown> {
  userId: string;
  next: string;
  invite: string | null;
}
export function sealPendingMfa(pending: PendingMfa, config: GoogleConfig): string {
  return sealCookie('mfa', { ...pending, jti: randomUUID() }, MFA_TTL_SECONDS, config);
}
/** Second step for MFA users: the sealed cookie proves the Google step; the code is checked as at login. */
export async function completeGooglePendingMfa(
  pending: (PendingMfa & { jti?: unknown }) | null,
  mfaCode: string,
  userAgent: string | null
): Promise<IssuedSession> {
  if (!pending || typeof pending.userId !== 'string' || typeof pending.jti !== 'string')
    throw new AuthError('Sign in with Google again', 401, 'google_expired');
  await enforceAuthRateLimit('google-mfa', pending.jti, 5, MFA_TTL_SECONDS);
  await enforceAuthRateLimit('login', pending.userId);
  return issueGoogleSession(pending.userId, { mfaCode, userAgent });
}

export async function linkGoogleIdentity(
  context: Pick<AuthContext, 'userId' | 'accountId' | 'sessionId'>,
  identity: GoogleIdentity
): Promise<void> {
  await getAuthPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${context.userId}::uuid FOR UPDATE`;
    const rows = await tx.$queryRaw<{ user_id: string; subject: string }[]>`
      SELECT user_id,subject FROM auth_identities WHERE provider='google'
        AND (subject=${identity.subject} OR user_id=${context.userId}::uuid) FOR UPDATE`;
    const bySubject = rows.find((row) => row.subject === identity.subject);
    if (bySubject && bySubject.user_id !== context.userId) throw new GoogleOidcError('google_in_use');
    if (bySubject) {
      await tx.$executeRaw`UPDATE auth_identities SET email=${identity.email} WHERE provider='google' AND subject=${identity.subject}`;
      return;
    }
    if (rows.some((row) => row.user_id === context.userId))
      throw new GoogleOidcError('google_already_linked');
    await tx.$executeRaw`INSERT INTO auth_identities(user_id,provider,subject,email) VALUES(${context.userId}::uuid,'google',${identity.subject},${identity.email})`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${context.accountId}::uuid,${context.userId}::uuid,'auth.google_linked',${context.sessionId},'{}'::jsonb)`;
  });
}
export async function unlinkGoogleIdentity(
  context: Pick<AuthContext, 'userId' | 'accountId' | 'sessionId'>,
  currentPassword: string
): Promise<boolean> {
  return getAuthPrisma().$transaction(async (tx) => {
    const users = await tx.$queryRaw<{ password_hash: string }[]>`
      SELECT password_hash FROM auth_users WHERE id=${context.userId}::uuid AND disabled_at IS NULL FOR UPDATE`;
    // Requiring the password also guarantees the person keeps a way to sign in.
    if (!users[0] || !(await verifyPassword(users[0].password_hash, currentPassword)))
      throw new AuthError('Current password is incorrect', 401, 'current_password_invalid');
    const removed = await tx.$executeRaw`DELETE FROM auth_identities WHERE user_id=${context.userId}::uuid AND provider='google'`;
    if (removed)
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${context.accountId}::uuid,${context.userId}::uuid,'auth.google_unlinked',${context.sessionId},'{}'::jsonb)`;
    return removed > 0;
  });
}
/** Confirms the password before a link flow starts. */
export async function confirmPasswordForLink(userId: string, currentPassword: string): Promise<void> {
  const users = await getAuthPrisma().$queryRaw<{ password_hash: string }[]>`
    SELECT password_hash FROM auth_users WHERE id=${userId}::uuid AND disabled_at IS NULL`;
  if (!users[0] || !(await verifyPassword(users[0].password_hash, currentPassword)))
    throw new AuthError('Current password is incorrect', 401, 'current_password_invalid');
}
export async function getGoogleLink(
  userId: string
): Promise<{ email: string; linkedAt: string } | null> {
  const rows = await getAuthPrisma().$queryRaw<{ email: string; linked_at: Date }[]>`
    SELECT email,linked_at FROM auth_identities WHERE user_id=${userId}::uuid AND provider='google'`;
  return rows[0] ? { email: rows[0].email, linkedAt: rows[0].linked_at.toISOString() } : null;
}
