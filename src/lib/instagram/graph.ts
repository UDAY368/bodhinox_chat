// Instagram API with Instagram Login client (Phase 11): graph.instagram.com,
// Instagram User tokens. Every Instagram host and token rule lives here and in
// config.ts, so a later move to Instagram API with Unified Login touches only
// those two files. Phase 10 (Meta Ads) is never called from here. graph.facebook.com
// is called only for an account connected through a Facebook Page (Stage 4,
// onConnection below) and for the Page login calls at the end of this file.
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
import { AsyncLocalStorage } from 'node:async_hooks';
import { leaseFetch } from '@/lib/jobs/lease';
import { MetaApiError, readMetaError } from '@/lib/whatsapp/meta-api';
import type { InstagramConnectionKind } from '@/types';
import { PAGE_LOGIN_SCOPES, REQUIRED_SCOPES, type InstagramConfig, type PageLoginConfig } from './config';
import {
  buttonTemplateFits, genericTemplateFits, iceBreakersFit, persistentMenuFits, quickRepliesFit, validCommentReply, validInstagramText,
  type IceBreaker, type IgGenericCard, type IgTemplateButton, type PersistentMenuItem, type QuickReply,
} from './graph-limits';

export {
  INSTAGRAM_LIMITS, buttonTemplateFits, genericTemplateFits, iceBreakersFit, persistentMenuFits, quickRepliesFit, utf8Bytes,
  validCommentReply, validInstagramText, type IceBreaker, type IgGenericCard, type IgTemplateButton, type PersistentMenuItem,
  type QuickReply,
} from './graph-limits';

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

// Stage 4: an account connected through a Facebook Page is reached on graph.facebook.com
// (same version, the Page token as the bearer, the Page id where these calls take the
// account id). Callers wrap the calls for such an account in onConnection(kind, ...);
// everything else keeps graph.instagram.com. The login and token-refresh calls above
// never follow it: they are Instagram Login only.
export const FACEBOOK_GRAPH_HOST = 'https://graph.facebook.com';
const FACEBOOK_BASE = `${FACEBOOK_GRAPH_HOST}/${INSTAGRAM_GRAPH_VERSION}`;
const connectionKind = new AsyncLocalStorage<InstagramConnectionKind>();

/** Run Instagram calls for an account of this connection kind (null or absent: Instagram Login). */
export function onConnection<T>(kind: InstagramConnectionKind | null | undefined, run: () => T): T {
  return connectionKind.run(kind === 'facebook_page' ? 'facebook_page' : 'instagram_login', run);
}

const graph = (path: string, params?: Params) =>
  withQuery(`${connectionKind.getStore() === 'facebook_page' ? FACEBOOK_BASE : GRAPH_BASE}/${path}`, params);
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

/**
 * Profile facts for the follow gate and segments (Stage 2). Each is null when
 * Meta did not return it. Needs live capture: the field names follow Meta's
 * Instagram user-profile docs and are not yet seen on an Instagram Login app.
 */
export interface InstagramProfileFacts {
  /** The customer follows the business account (is_user_follow_business). */
  followsBusiness: boolean | null;
  /** The business account follows the customer (is_business_follow_user). */
  businessFollows: boolean | null;
  /** is_verified_user. */
  isVerified: boolean | null;
  followerCount: number | null;
}

export interface InstagramProfile {
  name: string | null;
  username: string | null;
  /** Present only when asked for with `facts: true`. */
  facts?: InstagramProfileFacts;
}

export const PROFILE_FACT_FIELDS = ['is_user_follow_business', 'is_business_follow_user', 'is_verified_user', 'follower_count'] as const;

const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * A customer's display name and username (needs their consent; a 4xx means no
 * profile). With `facts: true` it also asks for the follow and verified fields;
 * without it the request is exactly the Phase 11 one.
 */
export async function getProfile(igsid: string, token: string, options: { facts?: boolean } = {}): Promise<InstagramProfile> {
  const fields = ['name', 'username', ...(options.facts ? PROFILE_FACT_FIELDS : [])].join(',');
  const row = await call<Record<string, unknown>>('GET', graph(assertId(igsid), { fields }), token);
  const profile: InstagramProfile = { name: str(row.name, 500), username: str(row.username, 64) };
  if (options.facts) profile.facts = {
    followsBusiness: bool(row.is_user_follow_business),
    businessFollows: bool(row.is_business_follow_user),
    isVerified: bool(row.is_verified_user),
    followerCount: count(row.follower_count),
  };
  return profile;
}

/**
 * Webhook fields this app subscribes to. `live_comments` (Stage 3) delivers
 * comments on the account's Instagram Live broadcasts, only while live; needs
 * live capture (its payload is built against Meta's documented shape).
 */
export type SubscribedField = 'messages' | 'messaging_postbacks' | 'comments' | 'live_comments';

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
  /** A reel (media_product_type REELS) rather than a feed post. */
  isReel: boolean;
}

/** One page of media and the cursor of the next page (null on the last page). */
export interface InstagramMediaPage {
  media: InstagramMedia[];
  next: string | null;
}

/** A Graph paging cursor as Meta issues it (opaque, URL-safe base64), checked before it reaches a URL. */
export const MEDIA_CURSOR = /^[A-Za-z0-9_\-=%]{1,512}$/;

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
  return (await listMediaPage(igUserId, token)).media;
}

/**
 * One page of the account's posts and reels, newest first, starting after
 * `after` (a cursor from an earlier page). The cursor is checked before it is
 * put in the URL; `next` is the cursor of the following page, or null.
 */
export async function listMediaPage(igUserId: string, token: string, after?: string): Promise<InstagramMediaPage> {
  if (after !== undefined && !MEDIA_CURSOR.test(after)) throw new InstagramGraphInputError('Invalid media cursor');
  const result = await call<{ data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown } }>('GET', graph(`${assertId(igUserId)}/media`, {
    fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp', limit: MEDIA_PAGE_SIZE, after,
  }), token);
  const cursor = result.paging?.cursors?.after;
  // Meta sends a next link only when another page exists; the cursor alone is also present on the last page.
  const next = typeof result.paging?.next === 'string' && typeof cursor === 'string' && MEDIA_CURSOR.test(cursor) ? cursor : null;
  return { media: mediaRows(result.data), next };
}

function mediaRows(data: unknown): InstagramMedia[] {
  const rows = Array.isArray(data) ? data.slice(0, MEDIA_PAGE_SIZE) : [];
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
      isReel: row.media_product_type === 'REELS',
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

/**
 * One private reply to a comment (recipient: { comment_id }). With
 * `quickReplies` (the "Opening DM" button) the message carries them; a tap
 * opens the 24-hour window. Needs live capture: a private reply carrying a
 * quick reply is built against Meta's documented message shape, not yet seen
 * on an Instagram Login app (callers keep it behind INSTAGRAM_ENABLED).
 */
export async function sendPrivateReply(igUserId: string, token: string, commentId: string, text: string,
  quickReplies?: readonly QuickReply[]): Promise<SentMessage> {
  if (quickReplies !== undefined && !quickRepliesFit(quickReplies)) throw new InstagramGraphInputError('Quick replies do not fit');
  return postMessage(igUserId, token, {
    recipient: { comment_id: assertId(commentId) },
    message: {
      text: assertText(text),
      ...(quickReplies ? { quick_replies: quickReplies.map((r) => ({ content_type: 'text', title: r.title.trim(), payload: r.payload })) } : {}),
    },
  });
}

const templateButton = (button: IgTemplateButton) => button.type === 'web_url'
  ? { type: 'web_url', url: button.url, title: button.title.trim() }
  : { type: 'postback', title: button.title.trim(), payload: button.payload };

/**
 * A generic template: one card, or a gallery of up to 10 (image, title,
 * subtitle, link, up to 3 buttons each). Built against Meta's documented
 * generic-template shape for Instagram.
 */
export async function sendGenericTemplate(igUserId: string, token: string, igsid: string, cards: readonly IgGenericCard[],
  options: SendOptions = {}): Promise<SentMessage> {
  if (!genericTemplateFits(cards)) throw new InstagramGraphInputError('Cards do not fit');
  return postMessage(igUserId, token, {
    recipient: { id: assertId(igsid) }, ...tagFields(options),
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: cards.map((card) => ({
            title: card.title.trim(),
            ...(card.subtitle ? { subtitle: card.subtitle.trim() } : {}),
            ...(card.imageUrl ? { image_url: card.imageUrl } : {}),
            ...(card.defaultUrl ? { default_action: { type: 'web_url', url: card.defaultUrl } } : {}),
            ...(card.buttons?.length ? { buttons: card.buttons.map(templateButton) } : {}),
          })),
        },
      },
    },
  });
}

/** A button template: text plus 1-3 real buttons (link or postback), not quick replies. */
export async function sendButtonTemplate(igUserId: string, token: string, igsid: string, text: string,
  buttons: readonly IgTemplateButton[], options: SendOptions = {}): Promise<SentMessage> {
  if (!buttonTemplateFits(text, buttons)) throw new InstagramGraphInputError('Buttons do not fit');
  return postMessage(igUserId, token, {
    recipient: { id: assertId(igsid) }, ...tagFields(options),
    message: { attachment: { type: 'template', payload: { template_type: 'button', text: text.trim(), buttons: buttons.map(templateButton) } } },
  });
}

export interface CommentReply { replyId: string }

/**
 * A public reply under a comment (POST /{comment-id}/replies). Callers send it
 * once per comment through dispatchOnce with the key `ig-comment-reply:{commentId}`.
 */
export async function replyToComment(commentId: string, token: string, text: string): Promise<CommentReply> {
  if (!validCommentReply(text)) throw new InstagramGraphInputError('Comment reply must be 1-2200 characters');
  const result = await call<{ id?: unknown }>('POST', graph(`${assertId(commentId)}/replies`), token, { json: { message: text.trim() } });
  const replyId = igId(result.id);
  // Accepted without an id: ambiguous, so a 5xx (dispatchOnce records 'unknown').
  if (!replyId) throw new MetaApiError('Meta API error: comment reply', { httpStatus: 502 });
  return { replyId };
}

/**
 * A comment as Meta has it now (GET /{comment-id}), for the AI comment
 * approval queue (Stage 3): Bodhinox stores no comment text, so the queue
 * reads it live, and a hidden or deleted comment (a 4xx) is never answered.
 * `text` is customer content: callers show it to staff and never log it.
 */
export interface InstagramComment {
  id: string;
  text: string | null;
  /** Hidden by the account (null when Meta did not say). */
  hidden: boolean | null;
  username: string | null;
  mediaId: string | null;
  timestamp: string | null;
}

export async function getComment(commentId: string, token: string): Promise<InstagramComment> {
  const row = await call<Record<string, unknown>>('GET',
    graph(assertId(commentId), { fields: 'id,text,hidden,timestamp,username,media' }), token);
  const id = igId(row.id);
  if (!id) throw new MetaApiError('Meta API error: comment', { httpStatus: 502 });
  const media = (row.media ?? {}) as Record<string, unknown>;
  return {
    id,
    text: typeof row.text === 'string' ? row.text.slice(0, 2200) : null,
    hidden: bool(row.hidden),
    username: str(row.username, 64),
    mediaId: igId(media.id),
    timestamp: typeof row.timestamp === 'string' && !Number.isNaN(Date.parse(row.timestamp))
      ? new Date(row.timestamp).toISOString() : null,
  };
}

// ---------------------------------------------------------------- messenger profile

/**
 * Replace the account's ice breakers (conversation starters, at most 4); an
 * empty list removes them. Needs live capture: built against Meta's documented
 * messenger_profile shape for Instagram ({ platform: 'instagram', ice_breakers:
 * [{ call_to_actions, locale }] }), not yet seen on an Instagram Login app.
 * Callers keep it behind INSTAGRAM_ENABLED.
 */
export async function setIceBreakers(igUserId: string, token: string, items: readonly IceBreaker[]): Promise<void> {
  if (!iceBreakersFit(items)) throw new InstagramGraphInputError('Ice breakers do not fit');
  const url = graph(`${assertId(igUserId)}/messenger_profile`);
  const result = items.length === 0
    ? await call<{ result?: unknown }>('DELETE', url, token, { json: { platform: 'instagram', fields: ['ice_breakers'] } })
    : await call<{ result?: unknown }>('POST', url, token, {
      json: {
        platform: 'instagram',
        ice_breakers: [{ locale: 'default', call_to_actions: items.map((i) => ({ question: i.question.trim(), payload: i.payload })) }],
      },
    });
  if (result.result !== 'success') throw new MetaApiError('Meta API error: messenger profile', { httpStatus: 502 });
}

/**
 * Replace the account's persistent menu (Stage 3, at most 20 items: links and
 * postbacks); an empty list removes it. Postback payloads are our own codes
 * (`menu:<flow id>`, postback-payloads.ts). Needs live capture: built against
 * Meta's documented messenger_profile shape ({ platform: 'instagram',
 * persistent_menu: [{ locale, call_to_actions }] }), not yet seen on an
 * Instagram Login app. Callers keep it behind INSTAGRAM_ENABLED.
 */
export async function setPersistentMenu(igUserId: string, token: string, items: readonly PersistentMenuItem[]): Promise<void> {
  if (!persistentMenuFits(items)) throw new InstagramGraphInputError('Menu does not fit');
  const url = graph(`${assertId(igUserId)}/messenger_profile`);
  const result = items.length === 0
    ? await call<{ result?: unknown }>('DELETE', url, token, { json: { platform: 'instagram', fields: ['persistent_menu'] } })
    : await call<{ result?: unknown }>('POST', url, token, {
      json: {
        platform: 'instagram',
        persistent_menu: [{
          locale: 'default',
          call_to_actions: items.map((item) => item.type === 'web_url'
            ? { type: 'web_url', title: item.title.trim(), url: item.url, webview_height_ratio: 'full' }
            : { type: 'postback', title: item.title.trim(), payload: item.payload }),
        }],
      },
    });
  if (result.result !== 'success') throw new MetaApiError('Meta API error: messenger profile', { httpStatus: 502 });
}

// ---------------------------------------------------------------- Facebook Page login (Stage 4)
//
// The optional second way to connect (agencies, ads, Conversions API). Needs live
// capture: built against Meta's documented Facebook Login / Page endpoints, not yet
// seen with this app; callers keep it behind INSTAGRAM_PAGE_LOGIN_ENABLED. Tokens
// here are secrets: the user token and every Page token travel in the Authorization
// header (the code and long-lived exchanges use the query parameters Meta defines),
// are stored only encrypted by the caller, and never reach a browser API or a log.

/** The Facebook Login dialog (Page permissions; the Instagram account is chosen from the Pages afterwards). */
export function buildFacebookLoginUrl(config: Pick<PageLoginConfig, 'appId' | 'redirectUri'>, input: { state: string }): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.state)) throw new InstagramGraphInputError('Invalid OAuth state');
  return withQuery(`https://www.facebook.com/${INSTAGRAM_GRAPH_VERSION}/dialog/oauth`, {
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: PAGE_LOGIN_SCOPES.join(','),
    state: input.state,
  });
}

export interface FacebookUserToken { accessToken: string; expiresInSeconds: number | null }

const facebookToken = (row: { access_token?: unknown; expires_in?: unknown }, what: string): FacebookUserToken => {
  if (typeof row.access_token !== 'string' || !row.access_token) throw new MetaApiError(`Meta API error: ${what}`, { httpStatus: 502 });
  return { accessToken: row.access_token, expiresInSeconds: seconds(row.expires_in) };
};

/** OAuth code -> Facebook user token (GET /oauth/access_token). */
export async function exchangeFacebookCode(config: PageLoginConfig, code: string): Promise<FacebookUserToken> {
  if (typeof code !== 'string' || !code || code.length > 2048) throw new InstagramGraphInputError('Invalid OAuth code');
  return facebookToken(await call<{ access_token?: unknown; expires_in?: unknown }>('GET',
    withQuery(`${FACEBOOK_BASE}/oauth/access_token`, {
      client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri, code,
    }), null), 'facebook code exchange');
}

/** Short-lived -> long-lived user token (a Page token read with it does not expire). */
export async function exchangeFacebookLongLived(config: Pick<PageLoginConfig, 'appId' | 'appSecret'>, shortToken: string): Promise<FacebookUserToken> {
  return facebookToken(await call<{ access_token?: unknown; expires_in?: unknown }>('GET',
    withQuery(`${FACEBOOK_BASE}/oauth/access_token`, {
      grant_type: 'fb_exchange_token', client_id: config.appId, client_secret: config.appSecret, fb_exchange_token: shortToken,
    }), null), 'facebook token exchange');
}

/** A Page the person manages that has an Instagram professional account linked. `pageToken` is a secret. */
export interface FacebookPageLink {
  pageId: string;
  pageName: string | null;
  pageToken: string;
  instagramUserId: string;
  instagramUsername: string | null;
}

/** The Pages the user manages with a linked Instagram account (GET /me/accounts); Pages without one are left out. */
export async function listPagesWithInstagram(userToken: string): Promise<FacebookPageLink[]> {
  const result = await call<{ data?: unknown }>('GET', withQuery(`${FACEBOOK_BASE}/me/accounts`, {
    fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100,
  }), userToken);
  const rows = Array.isArray(result.data) ? result.data.slice(0, 100) : [];
  const links: FacebookPageLink[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const ig = (row.instagram_business_account ?? {}) as Record<string, unknown>;
    const pageId = igId(row.id), instagramUserId = igId(ig.id);
    const pageToken = typeof row.access_token === 'string' && row.access_token ? row.access_token : null;
    if (!pageId || !instagramUserId || !pageToken) continue;
    links.push({ pageId, pageName: str(row.name, 500), pageToken, instagramUserId, instagramUsername: str(ig.username, 64) });
  }
  return links;
}

/** Webhook fields a Page subscription carries for Instagram messaging. */
export type PageSubscribedField = 'messages' | 'messaging_postbacks';

/** Subscribe this app to the Page's webhook fields (POST /{page-id}/subscribed_apps) with the Page token. */
export async function subscribePage(pageId: string, pageToken: string, fields: readonly PageSubscribedField[]): Promise<void> {
  if (fields.length === 0) throw new InstagramGraphInputError('No webhook fields');
  const result = await call<{ success?: unknown }>('POST',
    withQuery(`${FACEBOOK_BASE}/${assertId(pageId)}/subscribed_apps`, { subscribed_fields: [...new Set(fields)].join(',') }), pageToken);
  if (result.success !== true) throw new MetaApiError('Meta API error: page subscribe', { httpStatus: 502 });
}

/** Remove this app's Page webhook subscription (best effort on disconnect). */
export async function unsubscribePage(pageId: string, pageToken: string): Promise<void> {
  await call<unknown>('DELETE', `${FACEBOOK_BASE}/${assertId(pageId)}/subscribed_apps`, pageToken);
}

// Error classification shared with Phase 10 (same MetaApiError shape).
export { isMetaThrottle, isMetaTokenInvalid, metaErrorCode } from '@/lib/meta-ads/graph';
