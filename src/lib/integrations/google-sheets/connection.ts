// Stage 5 (5G): the workspace's Google Sheets connection (one active per
// workspace, table google_sheets_connections).
//
// An admin connects a Google account with OAuth (PKCE S256 and a signed,
// httpOnly state cookie bound to the admin's session and workspace). The
// refresh token is stored encrypted; the app role can write it once on connect
// but never read it (column grants), so it can never reach a browser response.
// The worker role reads it to mint short-lived access tokens for flow steps.
// Connect and disconnect are audited with ids only. Off unless
// GOOGLE_SHEETS_ENABLED and the OAuth client are configured.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx } from '@/lib/payments/ledger';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import {
  GOOGLE_SHEETS_HOSTS, GOOGLE_SHEETS_SCOPES, googleSheetsConfig, googleSheetsStatus,
  type GoogleSheetsConfig, type GoogleSheetsDisabledReason,
} from './config';
import { idTokenEmail, revokeToken, SheetsHttpError, tokenRequest } from './api';

export const SHEETS_OAUTH_COOKIE = 'bx_gsheets_oauth';
export const SHEETS_OAUTH_COOKIE_PATH = '/api/integrations/google-sheets';
export const SHEETS_STATE_TTL_MS = 10 * 60_000;
/** Where the callback sends the admin back to (the Settings section mounting the card). */
export const SHEETS_SETTINGS_PATH = '/settings?tab=connections';

export type SheetsErrorCode = 'not_enabled' | 'invalid_state' | 'denied' | 'missing_scopes' | 'no_refresh_token'
  | 'no_email' | 'provider_unreachable' | 'auth';

export class SheetsConnectionError extends Error {
  constructor(readonly code: SheetsErrorCode) {
    super(`Google Sheets connection: ${code}`);
    this.name = 'SheetsConnectionError';
  }
}

export interface SheetsActor { accountId: string; userId: string; role: NonNullable<TenantContext['role']> }

/** What the browser may see. Never a token. */
export interface SheetsConnectionDto {
  available: boolean;
  /** Why the integration is off on this server (flag or client configuration). */
  reason: GoogleSheetsDisabledReason | null;
  connected: boolean;
  status: 'active' | 'revoked' | 'error' | null;
  google_email: string | null;
  connected_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireConfig(): GoogleSheetsConfig {
  const config = googleSheetsConfig();
  if (!config) throw new SheetsConnectionError('not_enabled');
  return config;
}

const asWorker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

interface PublicRow { status: 'active' | 'revoked' | 'error'; google_email: string; created_at: Date }

/** The newest row, token column excluded (the app role cannot select it anyway). */
async function publicRow(tx: TenantTransaction, accountId: string): Promise<PublicRow | null> {
  const rows = await tx.$queryRaw<PublicRow[]>`SELECT status, google_email, created_at FROM google_sheets_connections
    WHERE account_id=${accountId}::uuid ORDER BY (status='active') DESC, created_at DESC LIMIT 1`;
  return rows[0] ?? null;
}

export function toDto(row: PublicRow | null): SheetsConnectionDto {
  const status = googleSheetsStatus();
  return {
    available: status.enabled,
    reason: status.enabled ? null : status.reason,
    connected: status.enabled && row?.status === 'active',
    status: row?.status ?? null,
    google_email: row?.google_email ?? null,
    connected_at: row?.created_at ? row.created_at.toISOString() : null,
  };
}

/** Any member may see whether Sheets is connected (read with the caller's own role; RLS scopes it). */
export async function getSheetsConnection(ctx: TenantContext): Promise<SheetsConnectionDto> {
  return toDto(await withTenant(ctx, (tx) => publicRow(tx, ctx.accountId)));
}

// ---------------------------------------------------------------------------
// OAuth state cookie

export interface SheetsOAuthState { nonce: string; accountId: string; userId: string; expiresAt: number; verifier: string }

const stateKey = (secret: string) => createHmac('sha256', secret).update('bodhinox:gsheets:oauth-state:v1').digest();
const sign = (secret: string, body: string) => createHmac('sha256', stateKey(secret)).update(body).digest('base64url');

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signSheetsState(secret: string, state: SheetsOAuthState): string {
  const body = Buffer.from(JSON.stringify({ n: state.nonce, a: state.accountId, u: state.userId, e: state.expiresAt, v: state.verifier }))
    .toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Null when missing, tampered or malformed (expiry is checked by the caller). */
export function readSheetsState(secret: string, cookie: string | null | undefined): SheetsOAuthState | null {
  if (!cookie || cookie.length > 2000) return null;
  const [body, mac, extra] = cookie.split('.');
  if (!body || !mac || extra !== undefined || !safeEqualText(mac, sign(secret, body))) return null;
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const state: SheetsOAuthState = {
      nonce: String(raw.n ?? ''), accountId: String(raw.a ?? ''), userId: String(raw.u ?? ''), expiresAt: Number(raw.e),
      verifier: String(raw.v ?? ''),
    };
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(state.nonce) || !UUID.test(state.accountId) || !UUID.test(state.userId)
      || !Number.isFinite(state.expiresAt) || !/^[A-Za-z0-9_-]{43,128}$/.test(state.verifier)) return null;
    return state;
  } catch {
    return null;
  }
}

const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** The Google consent URL (offline access so a refresh token is issued) and the signed state cookie value. */
export function startSheetsConnect(actor: SheetsActor): { authorizeUrl: string; cookie: string } {
  const config = requireConfig();
  const nonce = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const url = new URL(GOOGLE_SHEETS_HOSTS.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', GOOGLE_SHEETS_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', nonce);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  const cookie = signSheetsState(config.clientSecret, {
    nonce, accountId: actor.accountId, userId: actor.userId, expiresAt: Date.now() + SHEETS_STATE_TTL_MS, verifier,
  });
  return { authorizeUrl: url.toString(), cookie };
}

/**
 * Completes the callback for the admin who started it: checks the state,
 * exchanges the code (PKCE), requires the spreadsheets scope, a refresh token
 * and a verified email, then replaces the workspace's connection. The row is
 * written with the admin's own role, so RLS also requires an admin.
 */
export async function finishSheetsConnect(actor: SheetsActor, input: { code: string; state: string; cookie: string | null },
  fetcher: typeof fetch = fetch): Promise<SheetsConnectionDto> {
  const config = requireConfig();
  const state = readSheetsState(config.clientSecret, input.cookie);
  if (!state || !input.state || !safeEqualText(input.state, state.nonce) || state.accountId !== actor.accountId
    || state.userId !== actor.userId || state.expiresAt < Date.now() || !/^[A-Za-z0-9_./~-]{1,1024}$/.test(input.code))
    throw new SheetsConnectionError('invalid_state');
  let grant;
  try {
    grant = await tokenRequest({
      grant_type: 'authorization_code', code: input.code, redirect_uri: config.redirectUri,
      client_id: config.clientId, client_secret: config.clientSecret, code_verifier: state.verifier,
    }, fetcher);
  } catch (error) {
    throw new SheetsConnectionError(error instanceof SheetsHttpError && error.status >= 400 && error.status < 500 ? 'auth' : 'provider_unreachable');
  }
  if (!grant.scopes.includes(GOOGLE_SHEETS_SCOPES[0])) {
    await revokeToken(grant.refreshToken ?? grant.accessToken, fetcher);
    throw new SheetsConnectionError('missing_scopes');
  }
  if (!grant.refreshToken) throw new SheetsConnectionError('no_refresh_token');
  const email = idTokenEmail(grant.idToken);
  if (!email) {
    await revokeToken(grant.refreshToken, fetcher);
    throw new SheetsConnectionError('no_email');
  }
  const refreshToken = grant.refreshToken;
  const row = await withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gsheets-conn:${actor.accountId}`}, 0))`;
    const replaced = await tx.$executeRaw`DELETE FROM google_sheets_connections WHERE account_id=${actor.accountId}::uuid`;
    const [inserted] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO google_sheets_connections(account_id, google_email,
        refresh_token_encrypted, status, connected_by)
      VALUES(${actor.accountId}::uuid, ${email}, ${encrypt(refreshToken)}, 'active', ${actor.userId}::uuid) RETURNING id::text AS id`;
    await auditTx(tx, actor.accountId, actor.userId, 'integrations.google_sheets_connect', inserted.id, { replaced: replaced > 0 });
    return publicRow(tx, actor.accountId);
  });
  forgetAccessToken(actor.accountId);
  return toDto(row);
}

/**
 * Removes the workspace's connection (admin; RLS checks it) and revokes the
 * grant at Google best-effort. Allowed while the flag is off, so stored
 * tokens can always be cleared.
 */
export async function disconnectSheets(actor: SheetsActor, fetcher: typeof fetch = fetch): Promise<SheetsConnectionDto> {
  const stored = await asWorker(actor.accountId, (tx) => tx.$queryRaw<{ refresh_token_encrypted: string }[]>`
    SELECT refresh_token_encrypted FROM google_sheets_connections WHERE account_id=${actor.accountId}::uuid`);
  const row = await withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const removed = await tx.$queryRaw<{ id: string }[]>`DELETE FROM google_sheets_connections
      WHERE account_id=${actor.accountId}::uuid RETURNING id::text AS id`;
    for (const r of removed) await auditTx(tx, actor.accountId, actor.userId, 'integrations.google_sheets_disconnect', r.id, {});
    return publicRow(tx, actor.accountId);
  });
  forgetAccessToken(actor.accountId);
  for (const s of stored) {
    try {
      await revokeToken(decrypt(s.refresh_token_encrypted), fetcher);
    } catch {
      // An undecryptable token cannot be revoked; the row is gone either way.
    }
  }
  return toDto(row);
}

// ---------------------------------------------------------------------------
// Access tokens (worker)

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export function forgetAccessToken(accountId: string): void {
  accessTokens.delete(accountId);
}

export type AccessTokenResult = { ok: true; token: string } | { ok: false; reason: 'not_enabled' | 'not_connected' | 'sheets_failed' };

/**
 * A short-lived access token for the workspace's active connection, minted
 * from the stored refresh token (worker role). A refused refresh token marks
 * the connection 'error' so the card asks for a new connection.
 */
export async function sheetsAccessToken(accountId: string, fetcher: typeof fetch = fetch): Promise<AccessTokenResult> {
  const config = googleSheetsConfig();
  if (!config) return { ok: false, reason: 'not_enabled' };
  const cached = accessTokens.get(accountId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return { ok: true, token: cached.token };
  const [row] = await asWorker(accountId, (tx) => tx.$queryRaw<{ id: string; refresh_token_encrypted: string }[]>`
    SELECT id::text AS id, refresh_token_encrypted FROM google_sheets_connections
    WHERE account_id=${accountId}::uuid AND status='active' LIMIT 1`);
  if (!row) return { ok: false, reason: 'not_connected' };
  let refreshToken: string;
  try {
    refreshToken = decrypt(row.refresh_token_encrypted);
  } catch {
    return { ok: false, reason: 'not_connected' };
  }
  try {
    const grant = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId,
      client_secret: config.clientSecret }, fetcher);
    accessTokens.set(accountId, { token: grant.accessToken, expiresAt: Date.now() + grant.expiresInSeconds * 1000 });
    return { ok: true, token: grant.accessToken };
  } catch (error) {
    if (error instanceof SheetsHttpError && (error.reason === 'invalid_grant' || error.status === 401)) {
      await asWorker(accountId, (tx) => tx.$executeRaw`UPDATE google_sheets_connections SET status='error'
        WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND status='active'`);
      console.warn('[google sheets] connection needs attention', { reason: 'invalid_grant' });
      return { ok: false, reason: 'not_connected' };
    }
    console.warn('[google sheets] token refresh failed', { status: error instanceof SheetsHttpError ? error.status : 'network' });
    return { ok: false, reason: 'sheets_failed' };
  }
}
