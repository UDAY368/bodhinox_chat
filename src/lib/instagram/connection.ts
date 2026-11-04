// Instagram connection (Phase 11, design section 4). Owner: T2.
//
// Instagram API with Instagram Login. An admin starts the authorization
// (startConnect: authorize URL + a signed, httpOnly state cookie bound to the
// admin's session and workspace, Zoom pattern); the callback (finishConnect)
// exchanges the code for a short-lived and then a 60-day token, reads /me,
// refuses an Instagram account another workspace holds (account_in_use),
// subscribes the webhook fields, and then, in one worker tenant transaction with
// no network call inside it, checks the plan room (skipped for an account the
// workspace already holds live, so a reconnect is never blocked), upserts by
// (account_id, ig_user_id) and audits. Reconnect = connect again: the row is
// reused and reactivated. Disconnect unsubscribes (best effort), clears the
// token and keeps conversations and identities.
//
// Tokens are encrypted (src/lib/whatsapp/encryption.ts), read only through the
// worker role, and never reach a browser response, a URL or a log. While
// Instagram is off (instagramConfig() === null) every function that could call
// Instagram refuses with instagram_not_enabled before any database write.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PlanLimitError, requireFeature, requireRoomFor } from '@/lib/billing/entitlements';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { auditTx } from '@/lib/payments/ledger';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { COMMENTS_SCOPE, instagramConfig, missingScopes, REQUIRED_SCOPES, type InstagramConfig } from './config';
import { InstagramError } from './errors';
import {
  buildAuthorizeUrl, exchangeCode, exchangeLongLived, getMe, InstagramGraphInputError, isMetaTokenInvalid, metaErrorCode,
  subscribe, unsubscribe, type SubscribedField,
} from './graph';

export interface InstagramActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export type InstagramAccountStatus = 'active' | 'token_invalid' | 'permission_missing' | 'disconnected';

/** What settings may show: never a token. Dates are ISO strings (JSON-safe). */
export interface InstagramAccountView {
  id: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  status: InstagramAccountStatus;
  scopes: string[];
  /** Scopes each feature still needs (empty: the feature may run). */
  missingScopes: { dm: string[]; comments: string[] };
  accessExpiresAt: string | null;
  lastWebhookAt: string | null;
  lastErrorCode: string | null;
  unsupportedEventCount: number;
  unsupportedEventLastAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
}

export interface ConnectStart {
  /** The Instagram authorize URL to redirect to. */
  url: string;
  /** The signed state cookie value the callback checks. */
  stateCookie: string;
}

/** State cookie for the OAuth round trip (path /api/instagram, 10 minutes). */
export const INSTAGRAM_OAUTH_COOKIE = 'bx_ig_oauth';
export const INSTAGRAM_OAUTH_COOKIE_PATH = '/api/instagram';
export const INSTAGRAM_STATE_TTL_MS = 10 * 60_000;
/** Where the callback sends the admin back to (the Settings section mounting the Instagram card). */
export const INSTAGRAM_SETTINGS_PATH = '/settings?tab=instagram';
/** Used when Meta's long-lived exchange does not say how long the token lives (documented: 60 days). */
const DEFAULT_TOKEN_SECONDS = 60 * 24 * 60 * 60;

function requireConfig(): InstagramConfig {
  const config = instagramConfig();
  if (!config) throw new InstagramError('instagram_not_enabled');
  return config;
}

function requireAdmin(actor: InstagramActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new InstagramError('forbidden');
}

/** A worker transaction for this workspace (callers checked the session and role). */
export function asWorker<T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());
}

function isUniqueViolation(error: unknown): boolean {
  const failure = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } } | null;
  if (!failure || typeof failure !== 'object') return false;
  return failure.code === '23505' || failure.code === 'P2002' || failure.meta?.code === '23505'
    || failure.meta?.driverAdapterError?.cause?.originalCode === '23505';
}

/** The plan includes Instagram (PlanLimitError otherwise: the route answers it with the plan's message). */
async function requireEntitled(accountId: string): Promise<void> {
  await asWorker(accountId, (tx) => requireFeature(tx, accountId, 'instagram'));
}

/** Meta failure -> fixed code (never Meta's text). */
function metaFailure(error: unknown): InstagramError {
  if (error instanceof InstagramError) return error;
  if (error instanceof InstagramGraphInputError) return new InstagramError('invalid_request');
  if (isMetaTokenInvalid(error)) return new InstagramError('instagram_token_invalid');
  return new InstagramError('meta_error');
}

// ---------------------------------------------------------------- view

interface AccountRow {
  id: string;
  ig_user_id: string;
  username: string | null;
  name: string | null;
  status: InstagramAccountStatus;
  scopes: string[];
  token_expires_at: Date | null;
  last_webhook_at: Date | null;
  last_error_code: string | null;
  unsupported_event_count: number;
  unsupported_event_last_at: Date | null;
  connected_at: Date | null;
  disconnected_at: Date | null;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function toView(row: AccountRow): InstagramAccountView {
  const scopes = [...(row.scopes ?? [])];
  return {
    id: row.id,
    igUserId: row.ig_user_id,
    username: row.username,
    name: row.name,
    status: row.status,
    scopes,
    missingScopes: { dm: missingScopes(scopes, 'dm'), comments: missingScopes(scopes, 'comments') },
    accessExpiresAt: row.status === 'disconnected' ? null : iso(row.token_expires_at),
    lastWebhookAt: iso(row.last_webhook_at),
    lastErrorCode: row.last_error_code,
    unsupportedEventCount: row.unsupported_event_count,
    unsupportedEventLastAt: iso(row.unsupported_event_last_at),
    connectedAt: iso(row.connected_at),
    disconnectedAt: iso(row.disconnected_at),
  };
}

/** Token-free columns only: the app role holds column grants for exactly these. */
async function selectViews(tx: TenantTransaction, accountId: string, id: string | null = null): Promise<InstagramAccountView[]> {
  const rows = await tx.$queryRaw<AccountRow[]>`
    SELECT id::text AS id, ig_user_id, username, name, status, scopes, token_expires_at, last_webhook_at, last_error_code,
      unsupported_event_count, unsupported_event_last_at, connected_at, disconnected_at
    FROM instagram_accounts
    WHERE account_id=${accountId}::uuid AND (${id}::uuid IS NULL OR id=${id}::uuid)
    ORDER BY (status='disconnected'), connected_at DESC
    LIMIT 50`;
  return rows.map(toView);
}

/** Any member: the workspace's Instagram accounts, live first. Read as the member (app role, column grants). */
export async function listInstagramAccounts(actor: InstagramActor): Promise<InstagramAccountView[]> {
  return withTenant(actor, (tx) => selectViews(tx, actor.accountId));
}

export async function getInstagramAccountView(actor: InstagramActor, instagramAccountId: string): Promise<InstagramAccountView> {
  const [view] = await withTenant(actor, (tx) => selectViews(tx, actor.accountId, instagramAccountId));
  if (!view) throw new InstagramError('not_found');
  return view;
}

// ---------------------------------------------------------------- OAuth state cookie

export interface InstagramOAuthState {
  nonce: string;
  accountId: string;
  userId: string;
  expiresAt: number;
  /** The admin asked for comment replies too. */
  comments: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{32,64}$/;
const stateKey = (secret: string) => createHmac('sha256', secret).update('bodhinox:instagram:oauth-state:v1').digest();
const sign = (secret: string, body: string) => createHmac('sha256', stateKey(secret)).update(body).digest('base64url');

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signInstagramState(secret: string, state: InstagramOAuthState): string {
  const body = Buffer.from(JSON.stringify({
    n: state.nonce, a: state.accountId, u: state.userId, e: state.expiresAt, c: state.comments ? 1 : 0,
  })).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Null when missing, tampered or malformed (expiry is checked by the caller). */
export function readInstagramState(secret: string, cookie: string | null | undefined): InstagramOAuthState | null {
  if (!cookie || cookie.length > 2000) return null;
  const [body, mac, extra] = cookie.split('.');
  if (!body || !mac || extra !== undefined || !safeEqualText(mac, sign(secret, body))) return null;
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const state: InstagramOAuthState = {
      nonce: String(raw.n ?? ''), accountId: String(raw.a ?? ''), userId: String(raw.u ?? ''), expiresAt: Number(raw.e),
      comments: raw.c === 1,
    };
    if (!NONCE.test(state.nonce) || !UUID.test(state.accountId) || !UUID.test(state.userId) || !Number.isFinite(state.expiresAt))
      return null;
    return state;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- connect

/** Admin: the Instagram authorize URL and the signed state cookie. The plan check runs before the redirect. */
export async function startConnect(actor: InstagramActor, options: { comments?: boolean } = {}): Promise<ConnectStart> {
  const config = requireConfig();
  requireAdmin(actor);
  await requireEntitled(actor.accountId);
  const nonce = randomBytes(24).toString('base64url');
  const url = buildAuthorizeUrl(config, { state: nonce, comments: options.comments === true });
  const stateCookie = signInstagramState(config.appSecret, {
    nonce, accountId: actor.accountId, userId: actor.userId, expiresAt: Date.now() + INSTAGRAM_STATE_TTL_MS,
    comments: options.comments === true,
  });
  return { url, stateCookie };
}

/**
 * Plan room for connecting `igUserId`, unless this workspace already holds it
 * live (a reconnect of an existing account never needs room, as with WhatsApp
 * numbers). A new or previously disconnected account counts against the limit.
 * requireRoomFor takes the per-workspace limit lock before counting.
 */
async function requireRoomUnlessHeld(tx: TenantTransaction, accountId: string, igUserId: string): Promise<void> {
  const [held] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM instagram_accounts
    WHERE account_id=${accountId}::uuid AND ig_user_id=${igUserId} AND status<>'disconnected'`;
  if (held) return;
  await requireRoomFor(tx, accountId, 'instagram_accounts', async () => {
    const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM instagram_accounts
      WHERE account_id=${accountId}::uuid AND status<>'disconnected' AND ig_user_id<>${igUserId}`;
    return row?.n ?? 0;
  });
}

async function ownerOf(accountId: string, igUserId: string): Promise<string | null> {
  const rows = await asWorker(accountId, (tx) => tx.$queryRaw<{ owner: string | null }[]>`
    SELECT crm_instagram_owner_account(${igUserId})::text AS owner`);
  return rows[0]?.owner ?? null;
}

/**
 * The callback: state check, code -> short-lived -> long-lived token, /me,
 * cross-workspace check, webhook subscription, then one worker transaction (no
 * network call inside): plan room, upsert, audit.
 */
export async function finishConnect(actor: InstagramActor,
  input: { state: string | null; cookieState: string | null; code: string | null }): Promise<{ instagramAccountId: string }> {
  const config = requireConfig();
  requireAdmin(actor);
  const state = readInstagramState(config.appSecret, input.cookieState);
  if (!state || !input.state || !safeEqualText(input.state, state.nonce) || state.accountId !== actor.accountId
    || state.userId !== actor.userId || state.expiresAt < Date.now())
    throw new InstagramError('state_mismatch');
  if (!input.code || input.code.length > 2048 || !/^[A-Za-z0-9_.~#-]+$/.test(input.code)) throw new InstagramError('invalid_request');
  await requireEntitled(actor.accountId);

  let token: string;
  let expiresInSeconds: number;
  let scopes: string[];
  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    const short = await exchangeCode(config, input.code);
    const long = await exchangeLongLived(config, short.accessToken);
    token = long.accessToken;
    expiresInSeconds = long.expiresInSeconds ?? DEFAULT_TOKEN_SECONDS;
    // Meta lists the granted permissions on the code exchange. When it lists none, the requested set is
    // recorded; a permission that was not actually granted then surfaces as a rejected call.
    scopes = short.scopes.length ? short.scopes
      : [...new Set<string>([...REQUIRED_SCOPES.dm, ...(state.comments ? REQUIRED_SCOPES.comments : [])])];
    me = await getMe(token);
  } catch (error) {
    throw metaFailure(error);
  }

  const owner = await ownerOf(actor.accountId, me.userId);
  if (owner && owner !== actor.accountId) throw new InstagramError('account_in_use');

  // Pre-check the room before subscribing, so a full plan never subscribes; the transaction re-checks under its lock.
  await asWorker(actor.accountId, (tx) => requireRoomUnlessHeld(tx, actor.accountId, me.userId))
    .catch((error) => { throw error instanceof PlanLimitError ? new InstagramError('limit_reached') : error; });

  const dmReady = missingScopes(scopes, 'dm').length === 0;
  const status: InstagramAccountStatus = dmReady ? 'active' : 'permission_missing';
  let subscribed = false;
  if (dmReady) {
    const fields: SubscribedField[] = ['messages', 'messaging_postbacks'];
    if (scopes.includes(COMMENTS_SCOPE)) fields.push('comments');
    try {
      await subscribe(me.userId, token, fields);
      subscribed = true;
    } catch (error) {
      throw metaFailure(error);
    }
  }

  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  try {
    const id = await asWorker(actor.accountId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ig-conn:${actor.accountId}`}, 0))`;
      // After the workspace lock, so the held-or-room decision is consistent with the upsert.
      await requireRoomUnlessHeld(tx, actor.accountId, me.userId);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO instagram_accounts(account_id, ig_user_id, username, name, access_token_enc, token_expires_at,
          token_refreshed_at, scopes, status, webhook_subscribed_at, last_error_code, connected_by_user_id, connected_at,
          disconnected_at)
        VALUES(${actor.accountId}::uuid, ${me.userId}, ${me.username}, ${me.name}, ${encrypt(token)}, ${expiresAt}, now(),
          ${scopes}::text[], ${status}, ${subscribed ? new Date() : null}, NULL, ${actor.userId}::uuid, now(), NULL)
        ON CONFLICT (account_id, ig_user_id) DO UPDATE SET username=EXCLUDED.username, name=EXCLUDED.name,
          access_token_enc=EXCLUDED.access_token_enc, token_expires_at=EXCLUDED.token_expires_at,
          token_refreshed_at=EXCLUDED.token_refreshed_at, scopes=EXCLUDED.scopes, status=EXCLUDED.status,
          webhook_subscribed_at=EXCLUDED.webhook_subscribed_at, last_error_code=NULL,
          connected_by_user_id=EXCLUDED.connected_by_user_id, connected_at=now(), disconnected_at=NULL
        RETURNING id::text AS id`;
      await auditTx(tx, actor.accountId, actor.userId, 'instagram.connect', row.id, { status, comments: scopes.includes(COMMENTS_SCOPE) });
      return row.id;
    });
    return { instagramAccountId: id };
  } catch (error) {
    if (error instanceof PlanLimitError) {
      // The subscription is one per app and Instagram account: drop it only when, checked again now, no workspace
      // (another one, or this one through a concurrent connect) holds the account live. When unsure, keep it.
      if (subscribed) {
        const holder = await ownerOf(actor.accountId, me.userId).catch(() => 'unknown');
        if (holder === null) await unsubscribe(me.userId, token).catch(() => undefined);
      }
      throw new InstagramError('limit_reached');
    }
    // Another workspace connected the same Instagram account in the meantime: its subscription is the same one, keep it.
    if (isUniqueViolation(error)) throw new InstagramError('account_in_use');
    throw error;
  }
}

// ---------------------------------------------------------------- disconnect

interface SecretRow { id: string; ig_user_id: string; status: InstagramAccountStatus; access_token_enc: string | null }

/** Worker transactions only: the account with its encrypted token. */
export async function loadAccountSecretTx(tx: TenantTransaction, accountId: string, instagramAccountId: string,
  lock = false): Promise<SecretRow | null> {
  const rows = lock
    ? await tx.$queryRaw<SecretRow[]>`SELECT id::text AS id, ig_user_id, status, access_token_enc FROM instagram_accounts
        WHERE account_id=${accountId}::uuid AND id=${instagramAccountId}::uuid FOR UPDATE`
    : await tx.$queryRaw<SecretRow[]>`SELECT id::text AS id, ig_user_id, status, access_token_enc FROM instagram_accounts
        WHERE account_id=${accountId}::uuid AND id=${instagramAccountId}::uuid`;
  return rows[0] ?? null;
}

export function readToken(row: Pick<SecretRow, 'access_token_enc'>): string | null {
  if (!row.access_token_enc) return null;
  try {
    return decrypt(row.access_token_enc);
  } catch {
    return null;
  }
}

/**
 * Admin: unsubscribe (best effort), then clear the token and mark the row
 * disconnected. Conversations and identities stay (read-only in the inbox).
 */
export async function disconnect(actor: InstagramActor, instagramAccountId: string): Promise<InstagramAccountView> {
  requireConfig();
  requireAdmin(actor);
  if (!UUID.test(instagramAccountId)) throw new InstagramError('not_found');
  const row = await asWorker(actor.accountId, (tx) => loadAccountSecretTx(tx, actor.accountId, instagramAccountId));
  if (!row) throw new InstagramError('not_found');
  if (row.status !== 'disconnected') {
    const token = readToken(row);
    if (token) await unsubscribe(row.ig_user_id, token).catch(() => undefined);
    await asWorker(actor.accountId, async (tx) => {
      const changed = await tx.$executeRaw`UPDATE instagram_accounts SET status='disconnected', access_token_enc=NULL,
          token_expires_at=NULL, token_refreshed_at=NULL, webhook_subscribed_at=NULL, disconnected_at=now()
        WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid AND status<>'disconnected'`;
      if (changed) await auditTx(tx, actor.accountId, actor.userId, 'instagram.disconnect', instagramAccountId);
    });
  }
  return getInstagramAccountView(actor, instagramAccountId);
}

/** Meta's code[:subcode] for last_error_code (never a message), or null. */
export function errorCodeOf(error: unknown): string | null {
  const code = error instanceof MetaApiError ? metaErrorCode(error) : null;
  return code && /^[0-9:]{1,32}$/.test(code) ? code : null;
}
