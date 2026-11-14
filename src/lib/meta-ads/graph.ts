// Graph API client for click-to-WhatsApp ads: Marketing API (ad accounts,
// campaigns, insights), Pages (leadgen subscription, lead forms, leads) and the
// Conversions API for business messaging.
//
// Rules: tokens travel in the Authorization header, never in a URL (except the
// one OAuth code exchange Meta defines). A failed call throws a MetaApiError
// whose message is only "Meta API error: <status>" with Meta's code, subcode
// and fbtrace id: Meta's own error text (which can echo request data) is never
// kept, so it cannot reach logs or DTOs. Every call has a timeout, and every
// call goes through leaseFetch, which enforces the job lease inside a job and
// is a plain fetch elsewhere. Every id placed in a path is checked first.
import { leaseFetch } from '@/lib/jobs/lease';
import {

  MetaApiError,
  readMetaError,
} from '@/lib/whatsapp/meta-api';
import type { MetaAdsConfig } from './config';

/**
 * The Marketing API refuses retired versions (error 2635) instead of upgrading
 * them, so ads calls pin a current version of their own (v27.0, Nov 2026; v25
 * is the oldest still served). WhatsApp calls keep META_API_VERSION.
 */
export const META_ADS_API_VERSION = 'v27.0';
export const GRAPH_BASE = `https://graph.facebook.com/${META_ADS_API_VERSION}`;
const TIMEOUT_MS = 15_000;
/** Upper bound on followed result pages per call, so a runaway cursor cannot loop. */
const MAX_PAGES = 20;
const META_ID = /^\d{1,32}$/;

export class MetaGraphInputError extends Error {
  constructor() {
    super('Invalid Meta object id');
    this.name = 'MetaGraphInputError';
  }
}

function assertId(value: string): string {
  if (!META_ID.test(value)) throw new MetaGraphInputError();
  return value;
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

/** `code[:subcode]` for storage (matches the last_error_code CHECKs). */
export function metaErrorCode(error: unknown): string | null {
  if (!(error instanceof MetaApiError) || error.code === null) return null;
  return error.subcode === null ? String(error.code) : `${error.code}:${error.subcode}`;
}

/** HTTP 429, or a Meta rate-limit code: retry later. */
export function isMetaThrottle(error: unknown): boolean {
  if (!(error instanceof MetaApiError)) return false;
  return error.httpStatus === 429 || [4, 17, 32, 613, 80004].includes(error.code ?? -1);
}

/** The token is expired or revoked (code 190, or HTTP 401). */
export function isMetaTokenInvalid(error: unknown): boolean {
  return error instanceof MetaApiError && (error.code === 190 || error.httpStatus === 401);
}

type Params = Record<string, string | number | undefined>;

function url(path: string, params: Params = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  const qs = query.toString();
  return `${GRAPH_BASE}/${path}${qs ? `?${qs}` : ''}`;
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, token: string,
  options: { params?: Params; json?: unknown; form?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }
  const response = await leaseFetch(url(path, options.params), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) await failure(response);
  return (await response.json()) as T;
}

interface Paged<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Follows `after` cursors (never Meta's `next` URL) up to MAX_PAGES. */
async function getAll<T>(path: string, token: string, params: Params): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await request<Paged<T>>('GET', path, token, { params: { ...params, after } });
    out.push(...(result.data ?? []));
    after = result.paging?.next ? result.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const id = (value: unknown): string | null => (typeof value === 'string' && META_ID.test(value) ? value : null);
const currency = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
const count = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};
const money = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : 0;
};

// ---------------------------------------------------------------- login

/** A token Meta says is not a live user token of this app: treated like an expired one (code 190). */
const notOurToken = () => new MetaApiError('Meta API error: 400', { code: 190, httpStatus: 400 });

/**
 * The Login for Business popup's short-lived user token -> a long-lived one
 * (about 60 days). The JavaScript SDK's login code is bound to an internal
 * redirect address the server cannot reproduce (Meta refuses its exchange with
 * 100:36008), so the browser sends the token itself. It is accepted only when
 * Meta's debug_token says it is valid, belongs to this app and is a user token;
 * then Meta's own fb_exchange_token makes it long-lived (which also fails for
 * another app's token). Both are Meta-defined exchanges that take the token in
 * the query, the one exception to "tokens only in the Authorization header";
 * neither URL is ever logged.
 */
export async function exchangeLoginToken(config: Pick<MetaAdsConfig, 'appId' | 'appSecret'>, shortToken: string): Promise<{ accessToken: string }> {
  const appToken = `${config.appId}|${config.appSecret}`;
  const debug = await request<{ data?: { is_valid?: unknown; app_id?: unknown; type?: unknown } }>('GET', 'debug_token', appToken,
    { params: { input_token: shortToken } });
  const info = debug.data;
  if (info?.is_valid !== true || String(info.app_id) !== config.appId || (info.type !== undefined && info.type !== 'USER')) throw notOurToken();
  const response = await leaseFetch(url('oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: config.appId, client_secret: config.appSecret, fb_exchange_token: shortToken,
  }), { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) await failure(response);
  const data = (await response.json()) as { access_token?: unknown };
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Meta did not return a long-lived access token.');
  return { accessToken: data.access_token };
}

/** Permissions the user granted (status 'granted' only). */
export async function getGrantedScopes(userToken: string): Promise<string[]> {
  const rows = await getAll<{ permission?: unknown; status?: unknown }>('me/permissions', userToken, { limit: 100 });
  return rows
    .filter((row) => row.status === 'granted' && typeof row.permission === 'string' && /^[a-z_]{1,64}$/.test(row.permission))
    .map((row) => row.permission as string);
}

export interface MetaAdAccount { id: string; name: string | null; currency: string | null; businessId: string | null }

/** Ad accounts the user can use; `id` is without the `act_` prefix. */
export async function listAdAccounts(userToken: string): Promise<MetaAdAccount[]> {
  const rows = await getAll<{ account_id?: unknown; name?: unknown; currency?: unknown; business?: { id?: unknown } }>(
    'me/adaccounts', userToken, { fields: 'account_id,name,currency,business', limit: 100 });
  return rows.flatMap((row) => {
    const accountId = id(row.account_id);
    return accountId
      ? [{ id: accountId, name: str(row.name, 500), currency: currency(row.currency), businessId: id(row.business?.id) }]
      : [];
  });
}

export interface MetaPage { id: string; name: string | null; accessToken: string }

/** Pages the user manages, with their Page tokens (server side only). */
export async function listPages(userToken: string): Promise<MetaPage[]> {
  const rows = await getAll<{ id?: unknown; name?: unknown; access_token?: unknown }>(
    'me/accounts', userToken, { fields: 'id,name,access_token', limit: 100 });
  return rows.flatMap((row) => {
    const pageId = id(row.id);
    return pageId && typeof row.access_token === 'string' && row.access_token
      ? [{ id: pageId, name: str(row.name, 500), accessToken: row.access_token }]
      : [];
  });
}

// ---------------------------------------------------------------- pages and leads

/** Subscribe this app to the Page's leadgen webhook field. */
export async function subscribePageLeadgen(pageId: string, pageToken: string): Promise<void> {
  const result = await request<{ success?: unknown }>('POST', `${assertId(pageId)}/subscribed_apps`, pageToken,
    { form: { subscribed_fields: 'leadgen' } });
  if (result.success !== true) throw new MetaApiError('Meta API error: subscribe', { httpStatus: 502 });
}

/** Remove this app's Page webhook subscription. */
export async function unsubscribePage(pageId: string, pageToken: string): Promise<void> {
  await request<unknown>('DELETE', `${assertId(pageId)}/subscribed_apps`, pageToken);
}

export interface MetaLeadField { name: string; values: string[] }
export interface MetaLead {
  id: string;
  createdTime: string | null;
  formId: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  adName: string | null;
  campaignName: string | null;
  fieldData: MetaLeadField[];
}

const LEAD_FIELDS = 'id,created_time,form_id,ad_id,adset_id,campaign_id,ad_name,campaign_name,field_data';

function toLead(row: Record<string, unknown>): MetaLead | null {
  const leadId = id(row.id);
  if (!leadId) return null;
  const fields = Array.isArray(row.field_data) ? row.field_data.slice(0, 100) : [];
  return {
    id: leadId,
    createdTime: str(row.created_time, 64),
    formId: id(row.form_id),
    adId: id(row.ad_id),
    adsetId: id(row.adset_id),
    campaignId: id(row.campaign_id),
    adName: str(row.ad_name, 500),
    campaignName: str(row.campaign_name, 500),
    fieldData: fields.flatMap((field: { name?: unknown; values?: unknown }) => {
      const name = str(field?.name, 200);
      if (!name) return [];
      const values = Array.isArray(field.values)
        ? field.values.filter((v): v is string => typeof v === 'string').slice(0, 20).map((v) => v.slice(0, 1000))
        : [];
      return [{ name, values }];
    }),
  };
}

export async function getLead(leadgenId: string, pageToken: string): Promise<MetaLead> {
  const row = await request<Record<string, unknown>>('GET', assertId(leadgenId), pageToken, { params: { fields: LEAD_FIELDS } });
  const lead = toLead(row);
  if (!lead) throw new MetaApiError('Meta API error: lead', { httpStatus: 502 });
  return lead;
}

/** One page of a form's leads, newest data first; `since` is a unix time in seconds. */
export async function listFormLeads(formId: string, pageToken: string, options: { since?: number; after?: string } = {}):
Promise<{ leads: MetaLead[]; nextCursor: string | null }> {
  const filtering = options.since
    ? JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(options.since) }])
    : undefined;
  const result = await request<Paged<Record<string, unknown>>>('GET', `${assertId(formId)}/leads`, pageToken,
    { params: { fields: LEAD_FIELDS, limit: 100, filtering, after: options.after } });
  return {
    leads: (result.data ?? []).flatMap((row) => toLead(row) ?? []),
    nextCursor: result.paging?.next ? (result.paging.cursors?.after ?? null) : null,
  };
}

export interface MetaLeadForm { id: string; name: string | null; status: string | null; questions: unknown[] }

export async function listLeadForms(pageId: string, pageToken: string): Promise<MetaLeadForm[]> {
  const rows = await getAll<{ id?: unknown; name?: unknown; status?: unknown; questions?: unknown }>(
    `${assertId(pageId)}/leadgen_forms`, pageToken, { fields: 'id,name,status,questions', limit: 100 });
  return rows.flatMap((row) => {
    const formId = id(row.id);
    if (!formId) return [];
    const questions = Array.isArray(row.questions)
      ? row.questions.slice(0, 100).flatMap((q: { key?: unknown; label?: unknown; type?: unknown }) =>
        str(q?.key, 200) ? [{ key: str(q.key, 200), label: str(q.label, 500), type: str(q.type, 64) }] : [])
      : [];
    return [{ id: formId, name: str(row.name, 500), status: str(row.status, 32), questions }];
  });
}

// ---------------------------------------------------------------- marketing

export interface MetaCampaign { id: string; name: string | null; status: string | null; objective: string | null }

export async function listCampaigns(adAccountId: string, userToken: string): Promise<MetaCampaign[]> {
  const rows = await getAll<{ id?: unknown; name?: unknown; status?: unknown; objective?: unknown }>(
    `act_${assertId(adAccountId)}/campaigns`, userToken, { fields: 'id,name,status,objective', limit: 100 });
  return rows.flatMap((row) => {
    const campaignId = id(row.id);
    return campaignId
      ? [{ id: campaignId, name: str(row.name, 500), status: str(row.status, 64), objective: str(row.objective, 64) }]
      : [];
  });
}

export const CONVERSATION_STARTED_ACTION = 'onsite_conversion.messaging_conversation_started_7d';
/**
 * Action types that count as a lead or a purchase, most specific first. Meta
 * reports overlapping types (lead_grouped includes lead), so the first present
 * one is taken, never their sum.
 */
const LEAD_ACTIONS = ['onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_lead'];
const PURCHASE_ACTIONS = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_conversion.purchase'];

type Action = { action_type?: unknown; value?: unknown };
const actionsOf = (row: Record<string, unknown>): Action[] => (Array.isArray(row.actions) ? (row.actions as Action[]) : []);
const actionCount = (actions: Action[], types: readonly string[]): number => {
  for (const type of types) {
    const hit = actions.find((a) => a?.action_type === type);
    if (hit) return count(hit.value);
  }
  return 0;
};

export type InsightLevel = 'campaign' | 'adset' | 'ad';

export interface MetaInsightRow {
  level: InsightLevel;
  objectId: string;
  campaignId: string | null;
  /** The ad set of an ad row (and the ad set itself on an ad set row). */
  adsetId: string | null;
  name: string | null;
  objective: string | null;
  /** YYYY-MM-DD (the ad account's day). */
  day: string;
  spend: number;
  currency: string | null;
  impressions: number;
  clicks: number;
  linkClicks: number;
  conversationsStarted: number;
  leads: number;
  purchases: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (value: unknown): string | null => (typeof value === 'string' && DAY_RE.test(value) ? value : null);

/** Daily insights (time_increment=1) for a date range, at campaign, ad set or ad level. */
export async function getInsights(adAccountId: string, userToken: string,
  options: { level: InsightLevel; since: string; until: string }): Promise<MetaInsightRow[]> {
  const rows = await getAll<Record<string, unknown>>(`act_${assertId(adAccountId)}/insights`, userToken, {
    level: options.level,
    time_range: JSON.stringify({ since: options.since, until: options.until }),
    time_increment: 1,
    fields: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,objective,spend,account_currency,impressions,clicks,inline_link_clicks,actions,date_start',
    limit: 500,
  });
  return rows.flatMap((row) => {
    const objectId = id(options.level === 'ad' ? row.ad_id : options.level === 'adset' ? row.adset_id : row.campaign_id);
    const date = dayOf(row.date_start);
    if (!objectId || !date) return [];
    const actions = actionsOf(row);
    return [{
      level: options.level,
      objectId,
      campaignId: id(row.campaign_id),
      adsetId: options.level === 'campaign' ? null : id(row.adset_id),
      name: str(options.level === 'ad' ? row.ad_name : options.level === 'adset' ? row.adset_name : row.campaign_name, 500),
      objective: str(row.objective, 64),
      day: date,
      spend: money(row.spend),
      currency: currency(row.account_currency),
      impressions: count(row.impressions),
      clicks: count(row.clicks),
      linkClicks: count(row.inline_link_clicks),
      conversationsStarted: actionCount(actions, [CONVERSATION_STARTED_ACTION]),
      leads: actionCount(actions, LEAD_ACTIONS),
      purchases: actionCount(actions, PURCHASE_ACTIONS),
    }];
  });
}

export const AD_PLATFORMS = ['facebook', 'instagram', 'messenger', 'audience_network', 'whatsapp', 'threads', 'unknown'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];
const platformOf = (value: unknown): AdPlatform =>
  typeof value === 'string' && (AD_PLATFORMS as readonly string[]).includes(value) ? (value as AdPlatform) : 'unknown';

export interface MetaPlatformRow {
  campaignId: string;
  day: string;
  platform: AdPlatform;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  conversationsStarted: number;
  leads: number;
}

/** Daily campaign insights split by placement platform (Facebook, Instagram, Messenger, ...). */
export async function getPlatformInsights(adAccountId: string, userToken: string,
  options: { since: string; until: string }): Promise<MetaPlatformRow[]> {
  const rows = await getAll<Record<string, unknown>>(`act_${assertId(adAccountId)}/insights`, userToken, {
    level: 'campaign',
    breakdowns: 'publisher_platform',
    time_range: JSON.stringify({ since: options.since, until: options.until }),
    time_increment: 1,
    fields: 'campaign_id,spend,impressions,clicks,inline_link_clicks,actions,date_start',
    limit: 500,
  });
  // Unknown platforms fold into one 'unknown' row per campaign and day.
  const merged = new Map<string, MetaPlatformRow>();
  for (const row of rows) {
    const campaignId = id(row.campaign_id);
    const date = dayOf(row.date_start);
    if (!campaignId || !date) continue;
    const platform = platformOf(row.publisher_platform);
    const actions = actionsOf(row);
    const key = `${campaignId}|${date}|${platform}`;
    const prev = merged.get(key);
    const next: MetaPlatformRow = {
      campaignId, day: date, platform,
      spend: money(row.spend) + (prev?.spend ?? 0),
      impressions: count(row.impressions) + (prev?.impressions ?? 0),
      clicks: count(row.clicks) + (prev?.clicks ?? 0),
      linkClicks: count(row.inline_link_clicks) + (prev?.linkClicks ?? 0),
      conversationsStarted: actionCount(actions, [CONVERSATION_STARTED_ACTION]) + (prev?.conversationsStarted ?? 0),
      leads: actionCount(actions, LEAD_ACTIONS) + (prev?.leads ?? 0),
    };
    next.spend = Math.round(next.spend * 100) / 100;
    merged.set(key, next);
  }
  return [...merged.values()];
}

export const REACH_PRESETS = ['last_7d', 'last_30d', 'last_90d'] as const;
export type ReachPreset = (typeof REACH_PRESETS)[number];
export type ReachLevel = 'account' | InsightLevel;

export interface MetaReachRow { objectId: string; reach: number; frequency: number }

/**
 * Reach and frequency over one of Meta's fixed ranges. Reach counts unique
 * people, so it cannot be added up from daily rows; it is read per range.
 */
export async function getReach(adAccountId: string, userToken: string, level: ReachLevel, preset: ReachPreset): Promise<MetaReachRow[]> {
  const account = assertId(adAccountId);
  const rows = await getAll<Record<string, unknown>>(`act_${account}/insights`, userToken, {
    level: level === 'account' ? 'account' : level,
    date_preset: preset,
    fields: level === 'account' ? 'reach,frequency' : `${level === 'adset' ? 'adset_id' : level === 'ad' ? 'ad_id' : 'campaign_id'},reach,frequency`,
    limit: 500,
  });
  return rows.flatMap((row) => {
    const objectId = level === 'account' ? account : id(level === 'ad' ? row.ad_id : level === 'adset' ? row.adset_id : row.campaign_id);
    if (!objectId) return [];
    const frequency = typeof row.frequency === 'string' || typeof row.frequency === 'number' ? Number(row.frequency) : NaN;
    return [{ objectId, reach: count(row.reach), frequency: Number.isFinite(frequency) && frequency >= 0 && frequency < 1e6 ? Math.round(frequency * 10_000) / 10_000 : 0 }];
  });
}

// ---------------------------------------------------------------- ad management

export type AdObjectLevel = 'campaign' | 'adset' | 'ad';

export interface MetaAdObject {
  level: AdObjectLevel;
  id: string;
  campaignId: string | null;
  adsetId: string | null;
  name: string | null;
  /** What the advertiser set: ACTIVE, PAUSED, ARCHIVED, ... */
  status: string | null;
  /** What Meta is doing: ACTIVE, PAUSED, CAMPAIGN_PAUSED, IN_PROCESS, WITH_ISSUES, ... */
  effectiveStatus: string | null;
  objective: string | null;
  /** Minor units of the ad account currency; null when the object has no budget of that kind. */
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
  startTime: string | null;
  endTime: string | null;
  /** Ad sets: where the ad sends people (WHATSAPP, INSTAGRAM_DIRECT, MESSENGER, ON_AD, WEBSITE, ...). */
  destinationType: string | null;
  optimizationGoal: string | null;
  /** Ads: the creative's preview (Meta's signed image URLs refresh with each sync). */
  thumbnailUrl: string | null;
  imageUrl: string | null;
  creativeTitle: string | null;
  creativeBody: string | null;
  ctaType: string | null;
}

/** Meta's budget strings ("50000") -> integer minor units; "0" or absent means no budget of that kind. */
const budget = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,15}$/.test(text)) return null;
  const n = Number(text);
  return n > 0 ? n : null;
};
const time = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const OBJECT_FIELDS: Record<AdObjectLevel, string> = {
  campaign: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time',
  adset: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,destination_type,optimization_goal',
  ad: 'id,name,campaign_id,adset_id,status,effective_status,creative{thumbnail_url,image_url,title,body,call_to_action_type}',
};

/** An https URL Meta returned, or null (never another scheme, never over the column limit). */
const httpsUrl = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 2048 && /^https:\/\/[^\s]+$/.test(value) ? value : null;

function adObject(level: AdObjectLevel, row: Record<string, unknown>): MetaAdObject | null {
  const objectId = id(row.id);
  if (!objectId) return null;
  const creative = row.creative && typeof row.creative === 'object' ? (row.creative as Record<string, unknown>) : null;
  return {
    level,
    id: objectId,
    campaignId: level === 'campaign' ? objectId : id(row.campaign_id),
    adsetId: level === 'adset' ? objectId : level === 'ad' ? id(row.adset_id) : null,
    name: str(row.name, 500),
    status: str(row.status, 64),
    effectiveStatus: str(row.effective_status, 64),
    objective: str(row.objective, 64),
    dailyBudgetMinor: budget(row.daily_budget),
    lifetimeBudgetMinor: budget(row.lifetime_budget),
    startTime: time(row.start_time),
    endTime: time(level === 'campaign' ? row.stop_time : row.end_time),
    destinationType: level === 'adset' ? str(row.destination_type, 64) : null,
    optimizationGoal: level === 'adset' ? str(row.optimization_goal, 64) : null,
    thumbnailUrl: level === 'ad' ? httpsUrl(creative?.thumbnail_url) : null,
    imageUrl: level === 'ad' ? httpsUrl(creative?.image_url) : null,
    creativeTitle: level === 'ad' ? str(creative?.title, 500) : null,
    creativeBody: level === 'ad' ? str(creative?.body, 4000) : null,
    ctaType: level === 'ad' ? str(creative?.call_to_action_type, 64) : null,
  };
}

/** Every campaign, ad set and ad of the ad account (Meta's default edges: not deleted). */
export async function listAdObjects(adAccountId: string, token: string): Promise<MetaAdObject[]> {
  const base = `act_${assertId(adAccountId)}`;
  const levels: [AdObjectLevel, string][] = [['campaign', 'campaigns'], ['adset', 'adsets'], ['ad', 'ads']];
  const lists = await Promise.all(levels.map(([level, edge]) =>
    // Ads ask for 320px creative thumbnails (Meta's default is 64px).
    getAll<Record<string, unknown>>(`${base}/${edge}`, token, { fields: OBJECT_FIELDS[level], limit: 200,
      ...(level === 'ad' ? { thumbnail_width: 320, thumbnail_height: 320 } : {}) })
      .then((rows) => rows.flatMap((row) => adObject(level, row) ?? []))));
  return lists.flat();
}

/** One object's current values, read back from Meta (used to settle an ambiguous change). */
export async function getAdObject(objectId: string, level: AdObjectLevel, token: string): Promise<MetaAdObject | null> {
  const row = await request<Record<string, unknown>>('GET', assertId(objectId), token, { params: { fields: OBJECT_FIELDS[level] } });
  return adObject(level, row);
}

/**
 * Updates one campaign, ad set or ad (`POST /<id>`). The values are set, not
 * added, so sending the same change twice leaves the same result; callers
 * still send once (outbound intent) and read back after an ambiguous outcome.
 */
export async function updateAdObject(objectId: string, token: string, fields: Record<string, string>): Promise<{ success: boolean }> {
  const result = await request<{ success?: unknown }>('POST', assertId(objectId), token, { form: fields });
  return { success: result.success === true };
}

// ---------------------------------------------------------------- conversions API

/** The WABA's Conversions API dataset id, creating it when the WABA has none. */
export async function getOrCreateDataset(wabaId: string, token: string): Promise<string> {
  const path = `${assertId(wabaId)}/dataset`;
  const pick = (result: { id?: unknown; data?: { id?: unknown }[] }) => id(result.id) ?? id(result.data?.[0]?.id);
  const existing = pick(await request<{ id?: unknown; data?: { id?: unknown }[] }>('GET', path, token));
  if (existing) return existing;
  const created = pick(await request<{ id?: unknown }>('POST', path, token));
  if (!created) throw new MetaApiError('Meta API error: dataset', { httpStatus: 502 });
  return created;
}

export type CapiEventName = 'Purchase' | 'LeadSubmitted' | 'QualifiedLead' | 'InitiateCheckout' | 'AddToCart' | 'ViewContent' | 'OrderCreated';

export interface CapiEventPayload {
  event_name: CapiEventName;
  /** Unix seconds. */
  event_time: number;
  event_id: string;
  action_source: 'business_messaging';
  messaging_channel: 'whatsapp' | 'instagram';
  user_data: { whatsapp_business_account_id: string; ctwa_clid: string } | { ig_account_id: string; ig_sid: string };
  custom_data?: { value?: number; currency?: string };
}

/**
 * Builds the one business-messaging event the CAPI job sends. A WhatsApp event
 * is keyed by the WABA and the ad click id. An Instagram event (Stage 4C) is
 * keyed by the professional account and the person's Instagram-scoped id; its
 * field names follow Meta's documented customer-information parameters and are
 * NOT verified on a live dataset (needs live capture), so it stays behind
 * INSTAGRAM_CAPI_ENABLED.
 */
export function capiEvent(input: {
  eventName: CapiEventName; eventTime: Date; eventId: string;
  value?: number | null; currency?: string | null;
} & ({ wabaId: string; ctwaClid: string; instagram?: undefined } | { instagram: { accountId: string; igsid: string }; wabaId?: undefined; ctwaClid?: undefined })): CapiEventPayload {
  const custom: { value?: number; currency?: string } = {};
  if (typeof input.value === 'number' && Number.isFinite(input.value) && input.value >= 0) custom.value = input.value;
  if (input.currency && /^[A-Z]{3}$/.test(input.currency)) custom.currency = input.currency;
  return {
    event_name: input.eventName,
    event_time: Math.floor(input.eventTime.getTime() / 1000),
    event_id: input.eventId,
    action_source: 'business_messaging',
    messaging_channel: input.instagram ? 'instagram' : 'whatsapp',
    user_data: input.instagram
      ? { ig_account_id: assertId(input.instagram.accountId), ig_sid: assertId(input.instagram.igsid) }
      : { whatsapp_business_account_id: assertId(input.wabaId!), ctwa_clid: input.ctwaClid! },
    ...(Object.keys(custom).length ? { custom_data: custom } : {}),
  };
}

/** POST /{dataset_id}/events. A non-2xx throws a (sanitized) MetaApiError so dispatchOnce can classify it. */
export async function postCapiEvents(datasetId: string, token: string, events: CapiEventPayload[]): Promise<{ eventsReceived: number }> {
  if (events.length < 1 || events.length > 1000) throw new MetaGraphInputError();
  const result = await request<{ events_received?: unknown }>('POST', `${assertId(datasetId)}/events`, token, { json: { data: events } });
  return { eventsReceived: count(result.events_received) };
}

// ---------------------------------------------------------------- ad creation

export type AdKind = 'whatsapp' | 'instagram_direct' | 'lead_form' | 'website';

/** The campaign objective each kind runs under (Meta's outcome-based objectives, v27). */
export const KIND_OBJECTIVE: Record<AdKind, string> = {
  whatsapp: 'OUTCOME_ENGAGEMENT',
  instagram_direct: 'OUTCOME_ENGAGEMENT',
  lead_form: 'OUTCOME_LEADS',
  website: 'OUTCOME_TRAFFIC',
};

const created = (row: { id?: unknown }): { id: string } => {
  const objectId = id(row?.id);
  if (!objectId) throw new Error('Meta did not return an id');
  return { id: objectId };
};

/** Uploads an image (bytes) to the ad account's image library; Meta dedupes by content hash. */
export async function uploadAdImage(adAccountId: string, token: string, bytesBase64: string, name: string): Promise<{ hash: string; url: string | null }> {
  const result = await request<{ images?: Record<string, { hash?: unknown; url?: unknown }> }>(
    'POST', `act_${assertId(adAccountId)}/adimages`, token, { form: { bytes: bytesBase64, name } });
  const image = Object.values(result.images ?? {})[0];
  const hash = typeof image?.hash === 'string' && /^[0-9a-f]{16,64}$/.test(image.hash) ? image.hash : null;
  if (!hash) throw new Error('Meta did not return an image hash');
  return { hash, url: httpsUrl(image?.url) };
}

export async function createCampaign(adAccountId: string, token: string,
  input: { name: string; kind: AdKind; status: 'ACTIVE' | 'PAUSED' }): Promise<{ id: string }> {
  return created(await request('POST', `act_${assertId(adAccountId)}/campaigns`, token, { form: {
    name: input.name,
    objective: KIND_OBJECTIVE[input.kind],
    status: input.status,
    buying_type: 'AUCTION',
    special_ad_categories: '[]',
    // Budget sits on the ad set (v24+ requires this to be explicit).
    is_adset_budget_sharing_enabled: 'false',
  } }));
}

export interface AdSetInput {
  name: string;
  campaignId: string;
  kind: AdKind;
  pageId: string;
  dailyBudgetMinor: number;
  startTime: string;
  endTime: string | null;
  countries: string[];
  ageMin: number;
  ageMax: number;
  genders: number[];
  whatsappNumber: string | null;
  status: 'ACTIVE' | 'PAUSED';
}

const ADSET_DELIVERY: Record<AdKind, { destination_type: string; optimization_goal: string }> = {
  whatsapp: { destination_type: 'WHATSAPP', optimization_goal: 'CONVERSATIONS' },
  instagram_direct: { destination_type: 'INSTAGRAM_DIRECT', optimization_goal: 'CONVERSATIONS' },
  lead_form: { destination_type: 'ON_AD', optimization_goal: 'LEAD_GENERATION' },
  website: { destination_type: 'WEBSITE', optimization_goal: 'LINK_CLICKS' },
};

/** The ad set's form fields (exported for tests). */
export function adSetForm(input: AdSetInput): Record<string, string> {
  const targeting: Record<string, unknown> = {
    geo_locations: { countries: input.countries },
    age_min: input.ageMin,
    age_max: input.ageMax,
    // The audience is what the admin chose: Advantage+ audience expansion stays off.
    targeting_automation: { advantage_audience: 0 },
  };
  if (input.genders.length === 1) targeting.genders = input.genders;
  const promoted: Record<string, string> | null = input.kind === 'website' ? null
    : { page_id: assertId(input.pageId), ...(input.kind === 'whatsapp' && input.whatsappNumber ? { whatsapp_phone_number: input.whatsappNumber } : {}) };
  return {
    name: input.name,
    campaign_id: assertId(input.campaignId),
    ...ADSET_DELIVERY[input.kind],
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    daily_budget: String(input.dailyBudgetMinor),
    targeting: JSON.stringify(targeting),
    ...(promoted ? { promoted_object: JSON.stringify(promoted) } : {}),
    start_time: input.startTime,
    ...(input.endTime ? { end_time: input.endTime } : {}),
    status: input.status,
  };
}

export async function createAdSet(adAccountId: string, token: string, input: AdSetInput): Promise<{ id: string }> {
  return created(await request('POST', `act_${assertId(adAccountId)}/adsets`, token, { form: adSetForm(input) }));
}

export interface CreativeInput {
  name: string;
  kind: AdKind;
  pageId: string;
  instagramUserId: string | null;
  primaryText: string;
  headline: string | null;
  description: string | null;
  imageHash: string;
  linkUrl: string | null;
  leadFormId: string | null;
  ctaType: string;
  welcomeMessage: string | null;
}

/** The creative's object_story_spec for each kind (the shapes of Meta's v27 messaging, lead and traffic guides). */
export function creativeSpec(input: CreativeInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    message: input.primaryText,
    image_hash: input.imageHash,
    ...(input.headline ? { name: input.headline } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
  let link: Record<string, unknown>;
  switch (input.kind) {
    case 'whatsapp':
      link = {
        ...base,
        link: 'https://api.whatsapp.com/send',
        call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } },
        ...(input.welcomeMessage ? { page_welcome_message: {
          type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text',
          text_format: { customer_action_type: 'autofill_message', message: { autofill_message: { content: input.welcomeMessage }, text: input.welcomeMessage } },
        } } : {}),
      };
      break;
    case 'instagram_direct':
      link = { ...base, call_to_action: { type: 'INSTAGRAM_MESSAGE', value: { app_destination: 'INSTAGRAM_DIRECT' } } };
      break;
    case 'lead_form':
      link = { ...base, link: 'http://fb.me/', call_to_action: { type: input.ctaType, value: { lead_gen_form_id: input.leadFormId } } };
      break;
    case 'website':
      link = { ...base, link: input.linkUrl, call_to_action: { type: input.ctaType, value: { link: input.linkUrl } } };
      break;
  }
  return {
    page_id: assertId(input.pageId),
    ...(input.kind === 'instagram_direct' && input.instagramUserId ? { instagram_user_id: assertId(input.instagramUserId) } : {}),
    link_data: link,
  };
}

export async function createCreative(adAccountId: string, token: string, input: CreativeInput): Promise<{ id: string }> {
  return created(await request('POST', `act_${assertId(adAccountId)}/adcreatives`, token, { form: {
    name: input.name,
    object_story_spec: JSON.stringify(creativeSpec(input)),
  } }));
}

export async function createAd(adAccountId: string, token: string,
  input: { name: string; adsetId: string; creativeId: string; status: 'ACTIVE' | 'PAUSED' }): Promise<{ id: string }> {
  return created(await request('POST', `act_${assertId(adAccountId)}/ads`, token, { form: {
    name: input.name,
    adset_id: assertId(input.adsetId),
    creative: JSON.stringify({ creative_id: assertId(input.creativeId) }),
    status: input.status,
  } }));
}

/** The Instagram account linked to the Page (needed for click-to-Instagram-Direct ads), or null. */
export async function getPageInstagramAccount(pageId: string, token: string): Promise<string | null> {
  const row = await request<{ instagram_business_account?: { id?: unknown } }>('GET', assertId(pageId), token,
    { params: { fields: 'instagram_business_account' } });
  return id(row.instagram_business_account?.id);
}

/**
 * After an unclear create: the objects under `edge` (act_<id>/campaigns,
 * <campaign>/adsets, act_<id>/adcreatives, <adset>/ads) with exactly this
 * name, created at or after `since` when Meta reports a creation time.
 */
export async function findCreatedByName(edge: 'campaigns' | 'adsets' | 'adcreatives' | 'ads', parentId: string, token: string,
  name: string, since: Date): Promise<string[]> {
  const parent = edge === 'campaigns' || edge === 'adcreatives' ? `act_${assertId(parentId)}` : assertId(parentId);
  const rows = await getAll<{ id?: unknown; name?: unknown; created_time?: unknown }>(`${parent}/${edge}`, token,
    { fields: edge === 'adcreatives' ? 'id,name' : 'id,name,created_time', limit: 200 });
  const from = since.getTime() - 120_000;
  return rows.flatMap((row) => {
    const objectId = id(row.id);
    if (!objectId || row.name !== name) return [];
    const at = typeof row.created_time === 'string' ? Date.parse(row.created_time) : NaN;
    return Number.isFinite(at) && at < from ? [] : [objectId];
  });
}
