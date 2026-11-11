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
  META_API_VERSION,
  MetaApiError,
  exchangeEmbeddedSignupCode,
  readMetaError,
} from '@/lib/whatsapp/meta-api';
import type { MetaAdsConfig } from './config';

export const GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
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

/** Login for Business code -> user access token (Meta's OAuth code exchange). */
export async function exchangeLoginCode(config: Pick<MetaAdsConfig, 'appId' | 'appSecret'>, code: string): Promise<{ accessToken: string }> {
  try {
    return await exchangeEmbeddedSignupCode({ appId: config.appId, appSecret: config.appSecret, code });
  } catch (error) {
    if (error instanceof MetaApiError) throw sanitize(error);
    throw new Error('Meta did not return an access token for the login code.');
  }
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

export interface MetaInsightRow {
  level: 'campaign' | 'ad';
  objectId: string;
  campaignId: string | null;
  name: string | null;
  objective: string | null;
  /** YYYY-MM-DD (the ad account's day). */
  day: string;
  spend: number;
  currency: string | null;
  impressions: number;
  clicks: number;
  conversationsStarted: number;
}

/** Daily insights (time_increment=1) for a date range, at campaign or ad level. */
export async function getInsights(adAccountId: string, userToken: string,
  options: { level: 'campaign' | 'ad'; since: string; until: string }): Promise<MetaInsightRow[]> {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(options.since) || !day.test(options.until)) throw new MetaGraphInputError();
  const rows = await getAll<Record<string, unknown>>(`act_${assertId(adAccountId)}/insights`, userToken, {
    level: options.level,
    time_increment: 1,
    time_range: JSON.stringify({ since: options.since, until: options.until }),
    fields: 'campaign_id,campaign_name,ad_id,ad_name,objective,spend,account_currency,impressions,clicks,actions,date_start',
    limit: 500,
  });
  return rows.flatMap((row) => {
    const objectId = id(options.level === 'ad' ? row.ad_id : row.campaign_id);
    const date = typeof row.date_start === 'string' && day.test(row.date_start) ? row.date_start : null;
    if (!objectId || !date) return [];
    const actions = Array.isArray(row.actions) ? row.actions : [];
    const started = actions.find((a: { action_type?: unknown }) => a?.action_type === CONVERSATION_STARTED_ACTION) as
      { value?: unknown } | undefined;
    return [{
      level: options.level,
      objectId,
      campaignId: id(row.campaign_id),
      name: str(options.level === 'ad' ? row.ad_name : row.campaign_name, 500),
      objective: str(row.objective, 64),
      day: date,
      spend: money(row.spend),
      currency: currency(row.account_currency),
      impressions: count(row.impressions),
      clicks: count(row.clicks),
      conversationsStarted: count(started?.value),
    }];
  });
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
