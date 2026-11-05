// Zoom connection lifecycle (Phase 9, design §3, D1 and "Zoom token"). Owner: T2.
//
// Admin-managed General (OAuth) app: a workspace admin authorizes it once
// (PKCE S256, signed state cookie bound to the admin's session); we keep the
// encrypted access and refresh tokens. Every write runs through the worker
// client after the route's admin + integrations.meetings check (the app role
// can read neither token column), and every connect, reconnect, disconnect and
// settings change writes audit_logs with ids and codes only.
//
// Off by default: without zoomConfig() nothing here calls Zoom (mutations
// answer 503 not_configured, except disconnect, which only clears what is
// stored). A connection whose deployment config disappeared reads as not
// connected.
import { requireIntegrationRoom } from '@/lib/billing/limits';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appOrigin } from '@/lib/auth/csrf';
import { getEntitlements } from '@/lib/billing/entitlements';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx } from '@/lib/payments/ledger';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { zoomConfig, type ZoomConfig } from './config';
import { backfillMeetingSyncTx } from './jobs';
import { MeetingError, type MeetingActor, type MeetingConnectionDto, type MeetingConnectionStatus } from './types';
import { zoomCall, ZoomError, zoomRevoke, zoomTokenRequest, type ZoomTokenGrant } from './zoom-client';

/** State cookie for the OAuth round trip (path /api/integrations/zoom, 10 minutes). */
export const ZOOM_OAUTH_COOKIE = 'bx_zoom_oauth';
export const ZOOM_OAUTH_COOKIE_PATH = '/api/integrations/zoom';
export const ZOOM_STATE_TTL_MS = 10 * 60_000;
export const ZOOM_CALLBACK_PATH = '/api/integrations/zoom/callback';
/** Where the callback sends the admin back to (the Settings section mounting the Zoom card). */
export const ZOOM_SETTINGS_PATH = '/settings?tab=connections';
const ZOOM_AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
/** Refresh a token this close to expiry. */
const EXPIRY_MARGIN_MS = 60_000;
/** Zoom refresh tokens expire after 90 days; the sweep refreshes those older than this. */
const AGEING_REFRESH_DAYS = 80;

/**
 * What the app must be allowed to do. Each entry is satisfied by any one of
 * its names: Zoom's granular scopes for new apps, or the classic ones for
 * older apps. NOT CONFIRMED against Zoom's current scope catalogue (design
 * "Unverified at build time"): adjust here if Zoom names them differently.
 * When Zoom's token response lists no scopes at all, the grant is accepted
 * and a missing permission surfaces as a 4xx on the first meeting call.
 */
export const REQUIRED_ZOOM_SCOPES: readonly (readonly string[])[] = [
  ['meeting:write:meeting:admin', 'meeting:write:admin', 'meeting:write'],
  ['meeting:update:meeting:admin', 'meeting:write:admin', 'meeting:write'],
  ['meeting:delete:meeting:admin', 'meeting:write:admin', 'meeting:write'],
  ['meeting:read:list_meetings:admin', 'meeting:read:admin', 'meeting:read'],
  ['user:read:user:admin', 'user:read:admin', 'user:read'],
];

export function missingZoomScopes(granted: readonly string[] | null): string[] {
  if (granted === null) return [];
  const have = new Set(granted);
  return REQUIRED_ZOOM_SCOPES.filter((any) => !any.some((s) => have.has(s))).map((any) => any[0]);
}

function requireConfig(): ZoomConfig {
  const config = zoomConfig();
  if (!config) throw new MeetingError('not_configured');
  return config;
}

/** A worker transaction for this workspace (no role check: callers checked the session). */
function asWorker<T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());
}

function isUniqueViolation(error: unknown): boolean {
  const failure = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } } | null;
  if (!failure || typeof failure !== 'object') return false;
  return failure.code === '23505' || failure.code === 'P2002' || failure.meta?.code === '23505'
    || failure.meta?.driverAdapterError?.cause?.originalCode === '23505';
}

async function requireEntitled(accountId: string): Promise<void> {
  const e = await asWorker(accountId, (tx) => getEntitlements(tx, accountId));
  if (!e.features.online_meetings) throw new MeetingError('feature_unavailable');
}

// ---------------------------------------------------------------------------
// Public view

interface PublicRow {
  status: MeetingConnectionStatus;
  register_attendees: boolean;
  last_error_code: string | null;
  connected_at: Date | null;
}

async function liveRow(tx: TenantTransaction, accountId: string): Promise<PublicRow | null> {
  const rows = await tx.$queryRaw<PublicRow[]>`SELECT status, register_attendees, last_error_code, connected_at
    FROM meeting_connections WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`;
  return rows[0] ?? null;
}

function toDto(row: PublicRow | null): MeetingConnectionDto {
  const available = zoomConfig() !== null;
  return {
    available,
    connected: available && row?.status === 'active',
    status: row?.status ?? null,
    register_attendees: row?.register_attendees ?? false,
    last_error_code: row?.last_error_code ?? null,
    connected_at: row?.connected_at ? row.connected_at.toISOString() : null,
  };
}

/**
 * Any member may see whether Zoom is connected. Read through the worker client
 * with an explicit token-free column list (viewers cannot read the table).
 */
export async function getMeetingConnection(actor: MeetingActor): Promise<MeetingConnectionDto> {
  return toDto(await asWorker(actor.accountId, (tx) => liveRow(tx, actor.accountId)));
}

// ---------------------------------------------------------------------------
// OAuth state cookie (modelled on src/lib/integrations/shopify/oauth.ts)

export interface ZoomOAuthState {
  nonce: string;
  accountId: string;
  userId: string;
  expiresAt: number;
  /** PKCE code_verifier (the cookie is httpOnly, path-scoped and signed). */
  verifier: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stateKey = (secret: string) => createHmac('sha256', secret).update('bodhinox:zoom:oauth-state:v1').digest();
const sign = (secret: string, body: string) => createHmac('sha256', stateKey(secret)).update(body).digest('base64url');

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signZoomState(secret: string, state: ZoomOAuthState): string {
  const body = Buffer.from(JSON.stringify({ n: state.nonce, a: state.accountId, u: state.userId, e: state.expiresAt, v: state.verifier }))
    .toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Null when missing, tampered or malformed (expiry is checked by the caller). */
export function readZoomState(secret: string, cookie: string | null | undefined): ZoomOAuthState | null {
  if (!cookie || cookie.length > 2000) return null;
  const [body, mac, extra] = cookie.split('.');
  if (!body || !mac || extra !== undefined || !safeEqualText(mac, sign(secret, body))) return null;
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const state: ZoomOAuthState = {
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

export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const redirectUri = () => `${appOrigin()}${ZOOM_CALLBACK_PATH}`;

/** Starts the admin-managed authorization: the Zoom authorize URL and the signed state cookie value (PKCE S256). */
export async function startZoomConnect(actor: MeetingActor): Promise<{ authorizeUrl: string; cookie: string }> {
  const config = requireConfig();
  await requireEntitled(actor.accountId);
  const nonce = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const url = new URL(ZOOM_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', nonce);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  const cookie = signZoomState(config.clientSecret, {
    nonce, accountId: actor.accountId, userId: actor.userId, expiresAt: Date.now() + ZOOM_STATE_TTL_MS, verifier,
  });
  return { authorizeUrl: url.toString(), cookie };
}

const ZOOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Drops a grant we will not store. Zoom's revoke de-authorizes the app on the
 * whole Zoom account, so it runs only when we know which Zoom account granted
 * it and no workspace holds that account live. Otherwise the unused grant is
 * left to expire: revoking could uninstall an installation another workspace,
 * or this one, still depends on.
 */
async function discardGrant(config: ZoomConfig, accountId: string, grant: ZoomTokenGrant, zoomAccountId: string | null) {
  if (!zoomAccountId) return;
  const held = await asWorker(accountId, (tx) => tx.$queryRaw<{ account_id: string }[]>`
    SELECT account_id::text AS account_id FROM crm_resolve_zoom_connection(${zoomAccountId}) LIMIT 1`);
  if (held.length) return;
  await zoomRevoke(config, grant.accessToken);
}

/** Completes the callback: exchanges the code, checks scopes, stores encrypted tokens, audits. */
export async function finishZoomConnect(
  actor: MeetingActor,
  input: { code: string; state: string; cookie: string | null },
): Promise<MeetingConnectionDto> {
  const config = requireConfig();
  const state = readZoomState(config.clientSecret, input.cookie);
  if (!state || !input.state || !safeEqualText(input.state, state.nonce) || state.accountId !== actor.accountId
    || state.userId !== actor.userId || state.expiresAt < Date.now() || !/^[A-Za-z0-9_.~-]{1,512}$/.test(input.code))
    throw new MeetingError('invalid_state');
  await requireEntitled(actor.accountId);

  let grant: ZoomTokenGrant;
  try {
    grant = await zoomTokenRequest(config, {
      grant_type: 'authorization_code', code: input.code, redirect_uri: redirectUri(), code_verifier: state.verifier,
    });
  } catch (error) {
    throw new MeetingError(error instanceof ZoomError && error.kind === 'auth' ? 'auth' : 'provider_unreachable');
  }
  const missing = missingZoomScopes(grant.scopes).length > 0;
  let me: { id?: unknown; account_id?: unknown } | undefined;
  let reached = true;
  try {
    me = await zoomCall<{ id?: unknown; account_id?: unknown }>(grant.accessToken, 'GET', '/users/me');
  } catch {
    reached = false;
  }
  const zoomAccountId = typeof me?.account_id === 'string' ? me.account_id : '';
  const zoomUserId = typeof me?.id === 'string' ? me.id : '';
  const identified = reached && ZOOM_ID.test(zoomAccountId) && ZOOM_ID.test(zoomUserId);
  if (missing) {
    await discardGrant(config, actor.accountId, grant, identified ? zoomAccountId : null);
    throw new MeetingError('missing_scopes');
  }
  // Unidentified: never revoked (it may be the installation a live connection uses).
  if (!identified) throw new MeetingError('provider_unreachable');

  const expiresAt = new Date(Date.now() + grant.expiresInSeconds * 1000);
  const scopes = grant.scopes ?? [];
  try {
    const row = await asWorker(actor.accountId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zoom-conn:${actor.accountId}`}, 0))`;
      // The kept or retired row's token lock too (order: zoom-conn, then zoom-token, before any row lock), so a
      // refresh in flight cannot overwrite the new grant afterwards or mark the reconnected row token_invalid.
      const [live] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meeting_connections
        WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' LIMIT 1`;
      if (live) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zoom-token:${live.id}`}, 0))`;
      const [current] = await tx.$queryRaw<{ id: string; zoom_account_id: string | null }[]>`
        SELECT id::text AS id, zoom_account_id FROM meeting_connections
        WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' LIMIT 1 FOR UPDATE`;
      if (current && current.zoom_account_id === zoomAccountId) {
        // Reconnect to the same Zoom account: keep the row, so its meetings stay attached.
        await tx.$executeRaw`UPDATE meeting_connections SET status='active', authorized_zoom_user_id=${zoomUserId},
            access_token_enc=${encrypt(grant.accessToken)}, refresh_token_enc=${encrypt(grant.refreshToken)},
            token_expires_at=${expiresAt}, refresh_rotated_at=now(), scopes=${scopes}::text[], last_error_code=NULL,
            connected_by=${actor.userId}::uuid, connected_at=now(), updated_at=now()
          WHERE account_id=${actor.accountId}::uuid AND id=${current.id}::uuid`;
        await auditTx(tx, actor.accountId, actor.userId, 'integrations.zoom_reconnect', current.id, {});
        await backfillMeetingSyncTx(tx, actor.accountId);
        return liveRow(tx, actor.accountId);
      }
      if (current) await retireTx(tx, actor.accountId, current.id);
      // A first connection takes a slot of the plan's integrations; replacing the live one does not.
      else await requireIntegrationRoom(tx, actor.accountId);
      const [inserted] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO meeting_connections(account_id, provider, status,
          zoom_account_id, authorized_zoom_user_id, access_token_enc, refresh_token_enc, token_expires_at, refresh_rotated_at,
          scopes, connected_by, connected_at)
        VALUES(${actor.accountId}::uuid, 'zoom', 'active', ${zoomAccountId}, ${zoomUserId}, ${encrypt(grant.accessToken)},
          ${encrypt(grant.refreshToken)}, ${expiresAt}, now(), ${scopes}::text[], ${actor.userId}::uuid, now())
        RETURNING id::text AS id`;
      await auditTx(tx, actor.accountId, actor.userId, 'integrations.zoom_connect', inserted.id,
        current ? { replacedConnection: current.id } : {});
      await backfillMeetingSyncTx(tx, actor.accountId);
      return liveRow(tx, actor.accountId);
    });
    return toDto(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Another workspace holds this Zoom account. Nothing was saved; the grant is dropped, never revoked:
      // a revoke would de-authorize the installation that workspace uses.
      throw new MeetingError('zoom_account_in_use');
    }
    throw error;
  }
}

/** Marks a connection disconnected with blank tokens and detaches its live meetings. Returns how many were detached. */
async function retireTx(tx: TenantTransaction, accountId: string, connectionId: string): Promise<number> {
  await tx.$executeRaw`UPDATE meeting_connections SET status='disconnected', access_token_enc=NULL, refresh_token_enc=NULL,
      token_expires_at=NULL, disconnected_at=now(), updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid AND status<>'disconnected'`;
  // The meetings still exist in that Zoom account; their join links keep working.
  return tx.$executeRaw`UPDATE appointment_meetings SET sync_state='detached', claim_token=NULL, claimed_until=NULL, updated_at=now()
    WHERE account_id=${accountId}::uuid AND connection_id=${connectionId}::uuid AND sync_state IN ('creating','active','unknown')`;
}

/** The registration switch (admin; the card shows the email-sharing note first). */
export async function setRegisterAttendees(actor: MeetingActor, enabled: boolean): Promise<MeetingConnectionDto> {
  requireConfig();
  // The app role's admin_update policy and column grant are the backstop for the route's admin check.
  const row = await withTenant(actor, async (tx) => {
    const [updated] = await tx.$queryRaw<{ id: string }[]>`UPDATE meeting_connections SET register_attendees=${enabled}, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' RETURNING id::text AS id`;
    if (!updated) throw new MeetingError('not_connected');
    await auditTx(tx, actor.accountId, actor.userId, 'integrations.zoom_settings', updated.id, { registerAttendees: enabled });
    return liveRow(tx, actor.accountId);
  });
  return toDto(row);
}

/**
 * Disconnects (revocation failures recorded, not fatal): blanks the tokens, marks
 * the row disconnected, detaches live meetings and audits. `actorUserId` is null
 * for the app_deauthorized event (T3 attendance.ts). Works without deployment
 * config so stored tokens can always be cleared (no Zoom call then).
 */
export async function disconnectZoom(accountId: string, actorUserId: string | null, reason: 'admin' | 'deauthorized'): Promise<void> {
  const current = await asWorker(accountId, async (tx) => (await tx.$queryRaw<{
    id: string; status: MeetingConnectionStatus; access_token_enc: string | null; refresh_token_enc: string | null;
  }[]>`SELECT id::text AS id, status, access_token_enc, refresh_token_enc FROM meeting_connections
    WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`)[0] ?? null);
  if (!current) return;
  const config = zoomConfig();
  let revoke: 'ok' | 'failed' | 'skipped' = 'skipped';
  // After app_deauthorized Zoom already withdrew the grant.
  if (config && reason === 'admin' && current.refresh_token_enc) {
    let token: string | null = null;
    try { token = decrypt(current.refresh_token_enc); } catch { token = null; }
    revoke = token && (await zoomRevoke(config, token)) ? 'ok' : 'failed';
  }
  await asWorker(accountId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zoom-conn:${accountId}`}, 0))`;
    const detached = await retireTx(tx, accountId, current.id);
    await tx.$executeRaw`UPDATE meeting_connections SET last_error_code=${revoke === 'failed' ? 'revoke_failed' : null}
      WHERE account_id=${accountId}::uuid AND id=${current.id}::uuid`;
    await auditTx(tx, accountId, actorUserId, 'integrations.zoom_disconnect', current.id, { reason, revoke, detached });
  });
}

/**
 * app_deauthorized (T3 attendance.ts): disconnects the workspace's live
 * connection of `zoomAccountId`, unless the event is older than that
 * connection's current grant (a reconnect after the uninstall, while the event
 * waited in the queue) or was routed to a connection that has since been
 * replaced. Checked and retired in one transaction under the zoom-conn lock, so
 * it cannot race the OAuth callback. No Zoom call: Zoom already withdrew it.
 */
export async function deauthorizeZoom(accountId: string, input: {
  zoomAccountId: string; connectionId: string | null; eventAt: Date | null;
}): Promise<'disconnected' | 'stale' | 'none'> {
  return asWorker(accountId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zoom-conn:${accountId}`}, 0))`;
    const [live] = await tx.$queryRaw<{ id: string; connected_at: Date | null }[]>`SELECT id::text AS id, connected_at
      FROM meeting_connections WHERE account_id=${accountId}::uuid AND status<>'disconnected'
        AND zoom_account_id=${input.zoomAccountId} LIMIT 1 FOR UPDATE`;
    if (!live) return 'none';
    if (input.connectionId && input.connectionId !== live.id) return 'stale';
    if (input.eventAt && live.connected_at && live.connected_at.getTime() >= input.eventAt.getTime()) return 'stale';
    const detached = await retireTx(tx, accountId, live.id);
    await tx.$executeRaw`UPDATE meeting_connections SET last_error_code=NULL WHERE account_id=${accountId}::uuid AND id=${live.id}::uuid`;
    await auditTx(tx, accountId, null, 'integrations.zoom_disconnect', live.id, { reason: 'deauthorized', revoke: 'skipped', detached });
    return 'disconnected';
  });
}

// ---------------------------------------------------------------------------
// Tokens

type RefreshOutcome = { token: string } | { invalid: string };

/**
 * One worker transaction under an advisory lock per connection: return the
 * stored token when it is still fresh, otherwise refresh it. The refresh is
 * the one HTTP call made under a lock, because Zoom rotates refresh tokens and
 * two parallel refreshes would strand the connection.
 */
async function tokenTx(accountId: string, connectionId: string, force: boolean, rejected?: string): Promise<RefreshOutcome> {
  return asWorker(accountId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zoom-token:${connectionId}`}, 0))`;
    const [row] = await tx.$queryRaw<{
      status: MeetingConnectionStatus; access_token_enc: string | null; refresh_token_enc: string | null; token_expires_at: Date | null;
    }[]>`SELECT status, access_token_enc, refresh_token_enc, token_expires_at FROM meeting_connections
      WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid`;
    if (!row || row.status !== 'active' || !row.refresh_token_enc) throw new MeetingError('not_connected');
    // A token Zoom refused: refresh only while it is still the stored one (otherwise another job already did).
    if (rejected !== undefined && row.access_token_enc && decryptOrNull(row.access_token_enc) !== rejected) force = false;
    if (!force && row.access_token_enc && row.token_expires_at && row.token_expires_at.getTime() > Date.now() + EXPIRY_MARGIN_MS)
      return { token: decrypt(row.access_token_enc) };
    const config = requireConfig();
    let grant: ZoomTokenGrant;
    try {
      grant = await zoomTokenRequest(config, { grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token_enc) });
    } catch (error) {
      if (error instanceof ZoomError && (error.kind === 'auth' || error.kind === 'rejected')) {
        // Written in this transaction; the caller throws after the commit.
        const code = error.code === 'invalid_grant' ? 'invalid_grant' : 'refresh_rejected';
        // Only the grant we refreshed: a reconnect or disconnect that replaced it wins.
        await tx.$executeRaw`UPDATE meeting_connections SET status='token_invalid', last_error_code=${code}, updated_at=now()
          WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid AND status='active'
            AND refresh_token_enc=${row.refresh_token_enc}`;
        return { invalid: code };
      }
      throw new MeetingError('provider_unreachable');
    }
    await tx.$executeRaw`UPDATE meeting_connections SET access_token_enc=${encrypt(grant.accessToken)},
        refresh_token_enc=${encrypt(grant.refreshToken)}, token_expires_at=${new Date(Date.now() + grant.expiresInSeconds * 1000)},
        refresh_rotated_at=now(), last_error_code=NULL, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid AND refresh_token_enc=${row.refresh_token_enc}`;
    return { token: grant.accessToken };
  });
}

/**
 * A usable access token for the connection, refreshing it under an advisory
 * lock when it expires within 60 s (refresh tokens rotate). invalid_grant marks
 * the connection token_invalid (MeetingError 'auth'); a timeout throws
 * provider_unreachable and changes nothing (the job retries).
 */
export async function getZoomAccessToken(accountId: string, connectionId: string): Promise<string> {
  const outcome = await tokenTx(accountId, connectionId, false);
  if ('invalid' in outcome) throw new MeetingError('auth');
  return outcome.token;
}

/**
 * After Zoom answered 401 to `rejected`: a fresh token. Refreshes while the
 * stored token is still the rejected one, otherwise returns the stored one
 * (another job or a reconnect replaced it). Errors as getZoomAccessToken.
 */
export async function renewZoomAccessToken(accountId: string, connectionId: string, rejected: string): Promise<string> {
  const outcome = await tokenTx(accountId, connectionId, true, rejected);
  if ('invalid' in outcome) throw new MeetingError('auth');
  return outcome.token;
}

/**
 * A 401 with a token we had just renewed: the grant was withdrawn, staff must
 * reconnect. Marks token_invalid only while the connection still stores that
 * token, so a stale job never invalidates a reconnect or a newer refresh.
 */
export async function markZoomTokenRejected(accountId: string, connectionId: string, rejected: string): Promise<boolean> {
  return asWorker(accountId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zoom-token:${connectionId}`}, 0))`;
    const [row] = await tx.$queryRaw<{ access_token_enc: string | null }[]>`SELECT access_token_enc FROM meeting_connections
      WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid AND status='active'`;
    if (!row?.access_token_enc || decryptOrNull(row.access_token_enc) !== rejected) return false;
    await tx.$executeRaw`UPDATE meeting_connections SET status='token_invalid', last_error_code='api_unauthorized', updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid AND status='active' AND access_token_enc=${row.access_token_enc}`;
    return true;
  });
}

function decryptOrNull(value: string): string | null {
  try { return decrypt(value); } catch { return null; }
}

/** Sweep helper (T4 sweep.ts): refreshes the live connection when its refresh token is older than 80 days. */
export async function refreshZoomTokenIfAgeing(accountId: string): Promise<boolean> {
  if (!zoomConfig()) return false;
  const [row] = await asWorker(accountId, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meeting_connections
    WHERE account_id=${accountId}::uuid AND status='active'
      AND (refresh_rotated_at IS NULL OR refresh_rotated_at < now() - make_interval(days => ${AGEING_REFRESH_DAYS}))
    LIMIT 1`);
  if (!row) return false;
  const outcome = await tokenTx(accountId, row.id, true);
  return 'token' in outcome;
}
