// Facebook Page / Business Login for Instagram (Stage 4, 4E). The optional second
// way to connect an Instagram account, for agencies, ads and the Conversions API.
// It needs INSTAGRAM_PAGE_LOGIN_ENABLED (pageLoginConfig() !== null); while that is
// off every function refuses with instagram_not_enabled before any database or
// Meta work. Built against Meta's documented Facebook Login and Page endpoints:
// the permission list, the Page response shapes and the webhook delivery for a
// Page-connected account need a live capture before the flag is turned on.
//
// Flow (all admin, same workspace and session throughout):
//   1. startPageLogin: Facebook dialog URL plus a signed, httpOnly state cookie
//      (bound to the admin and workspace; its own key purpose, so an Instagram
//      Login state cookie can never satisfy it).
//   2. completePageLogin (the callback): state check before any Meta call, code ->
//      long-lived user token, granted permissions checked, then the user token is
//      sealed (AES-GCM, ENCRYPTION_KEY) into a second httpOnly cookie, 10 minutes,
//      bound to admin and workspace. The browser holds ciphertext only and no
//      response, URL or log ever carries a token.
//   3. listPageAccounts: the Pages with a linked Instagram account, ids and names only.
//   4. connectPageAccount: the client names an Instagram user id; the Page and its
//      token are taken from Meta's own list (never from the client), the webhook is
//      subscribed, and the Page token is stored encrypted through saveConnection.
//
// A Page token read with a long-lived user token does not expire, so the row gets
// a far-future token_expires_at (the token sweep never refreshes it: refresh is an
// Instagram Login call, see token-sweep.ts). Tokens never reach a browser API or a log.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PlanLimitError } from '@/lib/billing/entitlements';
import { leaseFetch } from '@/lib/jobs/lease';
import { MetaApiError, readMetaError } from '@/lib/whatsapp/meta-api';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { BASIC_SCOPE, COMMENTS_SCOPE, MESSAGES_SCOPE, pageLoginConfig, type PageLoginConfig } from './config';
import {
  asWorker, metaFailure, ownerOf, requireAdmin, requireEntitled, requireRoomUnlessHeld, saveConnection, type InstagramActor,
} from './connection';
import { InstagramError } from './errors';
import {
  buildFacebookLoginUrl, exchangeFacebookCode, exchangeFacebookLongLived, FACEBOOK_GRAPH_HOST, INSTAGRAM_GRAPH_VERSION,
  listPagesWithInstagram, subscribePage, unsubscribePage,
} from './graph';

/** State cookie of the Facebook round trip (path /api/instagram/page-login, 10 minutes). */
export const PAGE_LOGIN_STATE_COOKIE = 'bx_ig_pl_state';
/** The sealed user-token cookie that carries the admin from the callback to the account choice. */
export const PAGE_LOGIN_PICK_COOKIE = 'bx_ig_pl_pick';
export const PAGE_LOGIN_COOKIE_PATH = '/api/instagram/page-login';
export const PAGE_LOGIN_TTL_MS = 10 * 60_000;
/** Where the callback sends the admin back to (the Settings section mounting the Instagram card). */
export const PAGE_LOGIN_SETTINGS_PATH = '/settings?tab=instagram';
/** A Page token from a long-lived user token does not expire; this keeps the token sweep and the card from treating it as expiring. */
const PAGE_TOKEN_LIFETIME_MS = 10 * 365 * 24 * 60 * 60_000;
const TIMEOUT_MS = 15_000;
/** Page webhook fields every Page-connected account is subscribed to. */
const PAGE_WEBHOOK_FIELDS = ['messages', 'messaging_postbacks'] as const;

/** Facebook permissions the DM features need (comments add instagram_manage_comments). */
const DM_PERMISSIONS = ['pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'] as const;

function requireConfig(): PageLoginConfig {
  const config = pageLoginConfig();
  if (!config) throw new InstagramError('instagram_not_enabled');
  return config;
}

// ---------------------------------------------------------------- signed state cookie

export interface PageLoginState { nonce: string; accountId: string; userId: string; expiresAt: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{32,64}$/;
const stateKey = (secret: string) => createHmac('sha256', secret).update('bodhinox:instagram:page-login-state:v1').digest();
const sign = (secret: string, body: string) => createHmac('sha256', stateKey(secret)).update(body).digest('base64url');

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signPageLoginState(secret: string, state: PageLoginState): string {
  const body = Buffer.from(JSON.stringify({ n: state.nonce, a: state.accountId, u: state.userId, e: state.expiresAt })).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Null when missing, tampered or malformed (expiry is checked by the caller). */
export function readPageLoginState(secret: string, cookie: string | null | undefined): PageLoginState | null {
  if (!cookie || cookie.length > 2000) return null;
  const [body, mac, extra] = cookie.split('.');
  if (!body || !mac || extra !== undefined || !safeEqualText(mac, sign(secret, body))) return null;
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const state: PageLoginState = {
      nonce: String(raw.n ?? ''), accountId: String(raw.a ?? ''), userId: String(raw.u ?? ''), expiresAt: Number(raw.e),
    };
    if (!NONCE.test(state.nonce) || !UUID.test(state.accountId) || !UUID.test(state.userId) || !Number.isFinite(state.expiresAt)) return null;
    return state;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- sealed user-token cookie

interface Pick { accountId: string; userId: string; expiresAt: number; userToken: string; scopes: string[] }

/** AES-GCM seal (authenticated: tampering fails the decrypt). The payload is bound to the admin and workspace. */
export function sealPick(pick: Pick): string {
  return encrypt(JSON.stringify({ a: pick.accountId, u: pick.userId, e: pick.expiresAt, t: pick.userToken, s: pick.scopes }));
}

/** The pick for this admin and workspace, or null (missing, tampered, expired, someone else's). */
export function openPick(actor: InstagramActor, cookie: string | null | undefined, now = Date.now()): Pick | null {
  if (!cookie || cookie.length > 3500) return null;
  try {
    const raw = JSON.parse(decrypt(cookie)) as Record<string, unknown>;
    if (raw.a !== actor.accountId || raw.u !== actor.userId || typeof raw.t !== 'string' || !raw.t) return null;
    const expiresAt = Number(raw.e);
    if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
    const scopes = Array.isArray(raw.s) ? raw.s.filter((s): s is string => typeof s === 'string').slice(0, 20) : [];
    return { accountId: actor.accountId, userId: actor.userId, expiresAt, userToken: raw.t, scopes };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Meta reads (Page login only)

async function metaGet<T>(url: string, token: string, what: string): Promise<T> {
  const response = await leaseFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const error = await readMetaError(response, `Meta API error: ${response.status}`);
    // Meta's message and details are dropped: only the codes classification needs.
    throw new MetaApiError(`Meta API error: ${what} ${error.httpStatus}`, {
      code: error.code, subcode: error.subcode, type: error.type, fbtraceId: error.fbtraceId, httpStatus: error.httpStatus,
    });
  }
  return (await response.json()) as T;
}

const FACEBOOK_BASE = `${FACEBOOK_GRAPH_HOST}/${INSTAGRAM_GRAPH_VERSION}`;

/** The permissions the person granted (GET /me/permissions, status granted). */
export async function grantedPermissions(userToken: string): Promise<string[]> {
  const result = await metaGet<{ data?: unknown }>(`${FACEBOOK_BASE}/me/permissions?limit=100`, userToken, 'permissions');
  const rows = Array.isArray(result.data) ? result.data.slice(0, 100) : [];
  return rows.flatMap((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    return row.status === 'granted' && typeof row.permission === 'string' ? [row.permission] : [];
  });
}

/**
 * The Instagram-Login-style scopes a Facebook grant is recorded as, so every
 * feature gate (missingScopes) reads one vocabulary. Empty when the direct
 * message permissions are not all granted.
 */
export function scopesFromPermissions(granted: readonly string[]): string[] {
  const have = new Set(granted);
  if (!DM_PERMISSIONS.every((permission) => have.has(permission))) return [];
  return have.has('instagram_manage_comments') ? [BASIC_SCOPE, MESSAGES_SCOPE, COMMENTS_SCOPE] : [BASIC_SCOPE, MESSAGES_SCOPE];
}

/**
 * Health probe for a Page-connected account (the Instagram Login /me probe does not apply): the
 * Instagram account the Page links to, or null when it links none. Throws on Meta errors.
 */
export async function probePageLink(pageId: string, pageToken: string): Promise<string | null> {
  if (!/^\d{1,32}$/.test(pageId)) throw new InstagramError('invalid_request');
  const result = await metaGet<{ instagram_business_account?: { id?: unknown } }>(
    `${FACEBOOK_BASE}/${pageId}?fields=instagram_business_account%7Bid%7D`, pageToken, 'page link');
  const id = result.instagram_business_account?.id;
  return typeof id === 'string' && /^\d{1,32}$/.test(id) ? id : null;
}

// ---------------------------------------------------------------- start

export interface PageLoginStart { url: string; stateCookie: string }

/** Admin: the Facebook dialog URL and the signed state cookie. The plan check runs before the redirect. */
export async function startPageLogin(actor: InstagramActor): Promise<PageLoginStart> {
  const config = requireConfig();
  requireAdmin(actor);
  await requireEntitled(actor.accountId);
  const nonce = randomBytes(24).toString('base64url');
  const url = buildFacebookLoginUrl(config, { state: nonce });
  const stateCookie = signPageLoginState(config.appSecret, {
    nonce, accountId: actor.accountId, userId: actor.userId, expiresAt: Date.now() + PAGE_LOGIN_TTL_MS,
  });
  return { url, stateCookie };
}

// ---------------------------------------------------------------- callback

/**
 * The callback: the state matches the cookie, this admin and this workspace before any Meta call; then
 * code -> long-lived user token, permission check, and the sealed cookie value for the account choice.
 */
export async function completePageLogin(actor: InstagramActor,
  input: { state: string | null; cookieState: string | null; code: string | null }): Promise<{ pickCookie: string }> {
  const config = requireConfig();
  requireAdmin(actor);
  const state = readPageLoginState(config.appSecret, input.cookieState);
  if (!state || !input.state || !safeEqualText(input.state, state.nonce) || state.accountId !== actor.accountId
    || state.userId !== actor.userId || state.expiresAt < Date.now())
    throw new InstagramError('state_mismatch');
  if (!input.code || input.code.length > 2048 || !/^[A-Za-z0-9_.~#-]+$/.test(input.code)) throw new InstagramError('invalid_request');
  await requireEntitled(actor.accountId);

  let userToken: string;
  let scopes: string[];
  try {
    const short = await exchangeFacebookCode(config, input.code);
    userToken = (await exchangeFacebookLongLived(config, short.accessToken)).accessToken;
    scopes = scopesFromPermissions(await grantedPermissions(userToken));
  } catch (error) {
    throw metaFailure(error);
  }
  if (scopes.length === 0) throw new InstagramError('instagram_permission_missing');
  return { pickCookie: sealPick({ accountId: actor.accountId, userId: actor.userId, expiresAt: Date.now() + PAGE_LOGIN_TTL_MS, userToken, scopes }) };
}

// ---------------------------------------------------------------- choose and connect

/** What the browser may know about a connectable account: never a token. */
export interface PageAccountChoice { instagramUserId: string; username: string | null; pageId: string; pageName: string | null }

async function linksFor(pick: Pick) {
  try {
    return await listPagesWithInstagram(pick.userToken);
  } catch (error) {
    throw metaFailure(error);
  }
}

/** Admin: the Instagram accounts reachable through the Pages this person manages. */
export async function listPageAccounts(actor: InstagramActor, pickCookie: string | null): Promise<PageAccountChoice[]> {
  requireConfig();
  requireAdmin(actor);
  const pick = openPick(actor, pickCookie);
  if (!pick) throw new InstagramError('state_mismatch');
  return (await linksFor(pick)).map((link) => ({
    instagramUserId: link.instagramUserId, username: link.instagramUsername, pageId: link.pageId, pageName: link.pageName,
  }));
}

/** Admin: connect the chosen Instagram account through its Page. Ids come from Meta's list, never from the client. */
export async function connectPageAccount(actor: InstagramActor,
  input: { pickCookie: string | null; instagramUserId: string }): Promise<{ instagramAccountId: string }> {
  requireConfig();
  requireAdmin(actor);
  if (!/^\d{1,32}$/.test(input.instagramUserId)) throw new InstagramError('invalid_request');
  const pick = openPick(actor, input.pickCookie);
  if (!pick) throw new InstagramError('state_mismatch');
  await requireEntitled(actor.accountId);

  const link = (await linksFor(pick)).find((candidate) => candidate.instagramUserId === input.instagramUserId);
  if (!link) throw new InstagramError('not_found');

  const owner = await ownerOf(actor.accountId, link.instagramUserId);
  if (owner && owner !== actor.accountId) throw new InstagramError('account_in_use');
  // Pre-check the room before subscribing, so a full plan never subscribes; the transaction re-checks under its lock.
  await asWorker(actor.accountId, (tx) => requireRoomUnlessHeld(tx, actor.accountId, link.instagramUserId))
    .catch((error) => { throw error instanceof PlanLimitError ? new InstagramError('limit_reached') : error; });

  try {
    await subscribePage(link.pageId, link.pageToken, PAGE_WEBHOOK_FIELDS);
  } catch (error) {
    throw metaFailure(error);
  }
  const id = await saveConnection(actor, {
    me: { userId: link.instagramUserId, username: link.instagramUsername, name: link.pageName },
    token: link.pageToken,
    expiresAt: new Date(Date.now() + PAGE_TOKEN_LIFETIME_MS),
    scopes: pick.scopes,
    status: 'active',
    subscribed: true,
    kind: 'facebook_page',
    facebookPageId: link.pageId,
    release: () => unsubscribePage(link.pageId, link.pageToken),
  });
  return { instagramAccountId: id };
}
