// Instagram API with Instagram Login client (Phase 11): graph.instagram.com,
// Instagram User tokens. Every Instagram host and token rule lives here and in
// config.ts, so a later move to Instagram API with Unified Login touches only
// those two files. Phase 10 (graph.facebook.com) is never called from here.
//
// Rules (as src/lib/meta-ads/graph.ts): the token travels in the Authorization
// header, except the token-exchange and refresh calls Meta defines with query
// parameters. A failed call throws a MetaApiError whose message is only
// "Meta API error: <status>" with Meta's code, subcode and fbtrace id; Meta's
// own text is never kept, so it cannot reach logs or DTOs. Every call has a
// timeout and goes through leaseFetch (the job lease inside a job, a plain fetch
// elsewhere). Every id placed in a path is checked first. Input that breaks a
// documented limit throws InstagramGraphInputError before any request; callers
// validate first so it never reaches dispatchOnce.
import { leaseFetch } from '@/lib/jobs/lease';
import { MetaApiError, readMetaError } from '@/lib/whatsapp/meta-api';
import { REQUIRED_SCOPES, type InstagramConfig } from './config';
import { quickRepliesFit, validInstagramText, type QuickReply } from './graph-limits';

export { INSTAGRAM_LIMITS, quickRepliesFit, utf8Bytes, validInstagramText, type QuickReply } from './graph-limits';

/** Pinned for Instagram only (Meta's Send Messages samples, checked 2026-11-04). Not META_API_VERSION. */
export const INSTAGRAM_GRAPH_VERSION = 'v26.0';
export const INSTAGRAM_GRAPH_HOST = 'https://graph.instagram.com';
const GRAPH_BASE = `${INSTAGRAM_GRAPH_HOST}/${INSTAGRAM_GRAPH_VERSION}`;
const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const CODE_EXCHANGE_URL = 'https://api.instagram.com/oauth/access_token';
const TIMEOUT_MS = 15_000;
const IG_ID = /^\d{1,32}$/;

export class InstagramGraphInputError extends Error {
  constructor(reason = 'Invalid Instagram request') {
    super(reason);
    this.name = 'InstagramGraphInputError';
  }
}

function assertId(value: string): string {
  if (!IG_ID.test(value)) throw new InstagramGraphInputError('Invalid Instagram object id');
  return value;
}

function assertText(text: string): string {
  if (!validInstagramText(text)) throw new InstagramGraphInputError('Instagram text must be 1-1000 bytes');
  return text;
}

/** A MetaApiError without Meta's message or details. */
function sanitize(error: MetaApiError): MetaApiError {
  return new MetaApiError(`Meta API error: ${error.httpStatus}`, {
    code: error.code,
    subcode: error.subcode,
    type: error.type,
    fbtraceId: error.fbtraceId,
    httpStatus: error.httpStatus,
  });
}

async function failure(response: Response): Promise<never> {
  throw sanitize(await readMetaError(response, `Meta API error: ${response.status}`));
}

type Params = Record<string, string | number | undefined>;

function withQuery(base: string, params: Params = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  const qs = query.toString();
  return `${base}${qs ? `?${qs}` : ''}`;
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', url: string, token: string | null,
  options: { json?: unknown; form?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }
  const response = await leaseFetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) await failure(response);
  return parseIds(await response.text()) as T;
}

/**
 * Instagram returns some ids as JSON numbers above 2^53 (user_id from the code
 * exchange), which JSON.parse would round. Id-valued keys are read as strings.
 */
function parseIds(text: string): unknown {
  return JSON.parse(text.replace(/"(user_id|id|recipient_id)"\s*:\s*(\d{1,32})(?=\s*[,}\]])/g, '"$1":"$2"'));
}

const graph = (path: string, params?: Params) => withQuery(`${GRAPH_BASE}/${path}`, params);
const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const igId = (value: unknown): string | null => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && IG_ID.test(text) ? text : null;
};
const scopeList = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
    .filter((s) => /^[a-z_]{1,64}$/.test(s)).slice(0, 50);
};
const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

// ---------------------------------------------------------------- login and tokens

/** The Instagram Login authorize URL (DM scopes, plus comments when asked). */
export function buildAuthorizeUrl(config: Pick<InstagramConfig, 'appId' | 'redirectUri'>,
  input: { state: string; comments?: boolean }): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.state)) throw new InstagramGraphInputError('Invalid OAuth state');
  const scopes = new Set<string>([...REQUIRED_SCOPES.dm, ...(input.comments ? REQUIRED_SCOPES.comments : [])]);
  return withQuery(AUTHORIZE_URL, {
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: [...scopes].join(','),
    state: input.state,
  });
}

export interface ShortLivedToken { accessToken: string; userId: string | null; scopes: string[] }

/** OAuth code -> short-lived (1 h) Instagram User token. */
export async function exchangeCode(config: Pick<InstagramConfig, 'appId' | 'appSecret' | 'redirectUri'>,
  code: string): Promise<ShortLivedToken> {
  if (typeof code !== 'string' || !code || code.length > 2048) throw new InstagramGraphInputError('Invalid OAuth code');
  const result = await call<Record<string, unknown> & { data?: Record<string, unknown>[] }>('POST', CODE_EXCHANGE_URL, null, {
    form: {
      client_id: config.appId,
      client_secret: config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code: code.replace(/#_$/, ''),
    },
  });
  // Meta has returned both a flat object and { data: [ ... ] } for this call.
  const row = Array.isArray(result.data) ? (result.data[0] ?? {}) : result;
  const accessToken = typeof row.access_token === 'string' && row.access_token ? row.access_token : null;
  if (!accessToken) throw new MetaApiError('Meta API error: code exchange', { httpStatus: 502 });
  return { accessToken, userId: igId(row.user_id), scopes: scopeList(row.permissions) };
}

export interface LongLivedToken { accessToken: string; expiresInSeconds: number | null }

/** Short-lived -> 60-day token (GET /access_token?grant_type=ig_exchange_token). */
export async function exchangeLongLived(config: Pick<InstagramConfig, 'appSecret'>, shortToken: string): Promise<LongLivedToken> {
  const result = await call<{ access_token?: unknown; expires_in?: unknown }>('GET',
    withQuery(`${INSTAGRAM_GRAPH_HOST}/access_token`, {
      grant_type: 'ig_exchange_token', client_secret: config.appSecret, access_token: shortToken,
    }), null);
  if (typeof result.access_token !== 'string' || !result.access_token)
    throw new MetaApiError('Meta API error: token exchange', { httpStatus: 502 });
  return { accessToken: result.access_token, expiresInSeconds: seconds(result.expires_in) };
}

/** Refresh a long-lived token at least 24 h old (GET /refresh_access_token?grant_type=ig_refresh_token). */
export async function refreshToken(token: string): Promise<LongLivedToken> {
  const result = await call<{ access_token?: unknown; expires_in?: unknown }>('GET',
    withQuery(`${INSTAGRAM_GRAPH_HOST}/refresh_access_token`, { grant_type: 'ig_refresh_token', access_token: token }), null);
  if (typeof result.access_token !== 'string' || !result.access_token)
    throw new MetaApiError('Meta API error: token refresh', { httpStatus: 502 });
  return { accessToken: result.access_token, expiresInSeconds: seconds(result.expires_in) };
}

export interface InstagramMe { userId: string; username: string | null; name: string | null }

/** The professional account behind a token (user_id is the id webhooks carry in entry[].id; live check confirms). */
export async function getMe(token: string): Promise<InstagramMe> {
  const row = await call<Record<string, unknown>>('GET', graph('me', { fields: 'user_id,username,name' }), token);
  const userId = igId(row.user_id);
  if (!userId) throw new MetaApiError('Meta API error: me', { httpStatus: 502 });
  return { userId, username: str(row.username, 64), name: str(row.name, 500) };
}

export interface InstagramProfile { name: string | null; username: string | null }

/** A customer's display name and username (needs their consent; a 4xx means no profile). */
export async function getProfile(igsid: string, token: string): Promise<InstagramProfile> {
  const row = await call<Record<string, unknown>>('GET', graph(assertId(igsid), { fields: 'name,username' }), token);
  return { name: str(row.name, 500), username: str(row.username, 64) };
}

export type SubscribedField = 'messages' | 'messaging_postbacks' | 'comments';

/** Subscribe this app to the account's webhook fields. */
export async function subscribe(igUserId: string, token: string, fields: readonly SubscribedField[]): Promise<void> {
  if (fields.length === 0) throw new InstagramGraphInputError('No webhook fields');
  const result = await call<{ success?: unknown }>('POST',
    graph(`${assertId(igUserId)}/subscribed_apps`, { subscribed_fields: [...new Set(fields)].join(',') }), token);
  if (result.success !== true) throw new MetaApiError('Meta API error: subscribe', { httpStatus: 502 });
}

/** Remove this app's webhook subscription (best effort on disconnect). */
export async function unsubscribe(igUserId: string, token: string): Promise<void> {
  await call<unknown>('DELETE', graph(`${assertId(igUserId)}/subscribed_apps`), token);
}

// ---------------------------------------------------------------- media

export const MEDIA_PAGE_SIZE = 50;

export interface InstagramMedia {
  id: string;
  caption: string | null;
  mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | null;
  /** An https Instagram CDN image for the picker (the video thumbnail for a video), or null. */
  previewUrl: string | null;
  /** The post's https://www.instagram.com/... link, or null. */
  permalink: string | null;
  timestamp: string | null;
}

const MEDIA_TYPES = new Set(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']);
const httpsUrl = (value: unknown, host?: RegExp): string | null => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (!host || host.test(url.hostname)) ? url.toString() : null;
  } catch {
    return null;
  }
};

/** The account's most recent posts, newest first (GET /{ig-user-id}/media). Only checked fields come back. */
export async function listMedia(igUserId: string, token: string): Promise<InstagramMedia[]> {
  const result = await call<{ data?: unknown }>('GET', graph(`${assertId(igUserId)}/media`, {
    fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp', limit: MEDIA_PAGE_SIZE,
  }), token);
  const rows = Array.isArray(result.data) ? result.data.slice(0, MEDIA_PAGE_SIZE) : [];
  const media: InstagramMedia[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id = igId(row.id);
    if (!id) continue;
    const mediaType = typeof row.media_type === 'string' && MEDIA_TYPES.has(row.media_type)
      ? row.media_type as InstagramMedia['mediaType'] : null;
    media.push({
      id,
      caption: str(row.caption, 300),
      mediaType,
      previewUrl: httpsUrl(mediaType === 'VIDEO' ? row.thumbnail_url : row.media_url),
      permalink: httpsUrl(row.permalink, /^(www\.)?instagram\.com$/),
      timestamp: typeof row.timestamp === 'string' && !Number.isNaN(Date.parse(row.timestamp))
        ? new Date(row.timestamp).toISOString() : null,
    });
  }
  return media;
}

// ---------------------------------------------------------------- messaging

export interface SendOptions {
  /** Staff composer send between 24 h and 7 days, only with INSTAGRAM_HUMAN_AGENT_ENABLED (window.ts decides). */
  humanAgentTag?: boolean;
}
export interface SentMessage { messageId: string; recipientId: string | null }

function tagFields(options: SendOptions): Record<string, string> {
  // (unconfirmed) exact tag field; the live check confirms it.
  return options.humanAgentTag ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : {};
}

async function postMessage(igUserId: string, token: string, body: Record<string, unknown>): Promise<SentMessage> {
  const result = await call<{ message_id?: unknown; recipient_id?: unknown }>('POST',
    graph(`${assertId(igUserId)}/messages`), token, { json: body });
  // Accepted without an id: the outcome is ambiguous, so it is a 5xx (dispatchOnce records 'unknown').
  if (typeof result.message_id !== 'string' || !result.message_id || result.message_id.length > 512)
    throw new MetaApiError('Meta API error: send', { httpStatus: 502 });
  return { messageId: result.message_id, recipientId: igId(result.recipient_id) };
}

export async function sendText(igUserId: string, token: string, igsid: string, text: string,
  options: SendOptions = {}): Promise<SentMessage> {
  return postMessage(igUserId, token, {
    recipient: { id: assertId(igsid) }, ...tagFields(options), message: { text: assertText(text) },
  });
}

export type InstagramAttachmentType = 'image' | 'audio' | 'video' | 'file';

export async function sendAttachment(igUserId: string, token: string, igsid: string,
  attachment: { type: InstagramAttachmentType; url: string }, options: SendOptions = {}): Promise<SentMessage> {
  if (!['image', 'audio', 'video', 'file'].includes(attachment.type)) throw new InstagramGraphInputError('Unsupported attachment');
  let parsed: URL;
  try { parsed = new URL(attachment.url); } catch { throw new InstagramGraphInputError('Invalid attachment URL'); }
  if (parsed.protocol !== 'https:' || attachment.url.length > 2048) throw new InstagramGraphInputError('Invalid attachment URL');
  return postMessage(igUserId, token, {
    recipient: { id: assertId(igsid) }, ...tagFields(options),
    message: { attachment: { type: attachment.type, payload: { url: attachment.url } } },
  });
}

export async function sendQuickReplies(igUserId: string, token: string, igsid: string, text: string,
  replies: readonly QuickReply[], options: SendOptions = {}): Promise<SentMessage> {
  if (!quickRepliesFit(replies)) throw new InstagramGraphInputError('Quick replies do not fit');
  return postMessage(igUserId, token, {
    recipient: { id: assertId(igsid) }, ...tagFields(options),
    message: {
      text: assertText(text),
      quick_replies: replies.map((r) => ({ content_type: 'text', title: r.title.trim(), payload: r.payload })),
    },
  });
}

/** One private reply to a comment (recipient: { comment_id }). */
export async function sendPrivateReply(igUserId: string, token: string, commentId: string, text: string): Promise<SentMessage> {
  return postMessage(igUserId, token, { recipient: { comment_id: assertId(commentId) }, message: { text: assertText(text) } });
}

// Error classification shared with Phase 10 (same MetaApiError shape).
export { isMetaThrottle, isMetaTokenInvalid, metaErrorCode } from '@/lib/meta-ads/graph';
