// Ad creation (ads module, part E): click-to-WhatsApp, click-to-Instagram-Direct,
// instant-form lead and website traffic ads, created from Bodhinox.
//
// Request: requestAdCreate runs after the route's session, CSRF and admin
// checks. In one worker transaction it re-checks the connection, the ad
// account, the permissions and the workspace's daily budget cap, records the
// draft and queues its meta.ad_create job, so nothing is acknowledged before it
// is durable.
//
// Create: the job makes the campaign, ad set, creative and ad in that order,
// each through its own outbound intent (adcreate:<draft>:<step>), storing each
// Meta id before the next step, so a retry continues where it stopped and never
// makes a step twice. Everything is created ACTIVE when the admin chose to
// publish (Meta then reviews the ad) and PAUSED otherwise. After an ambiguous
// outcome the step's object is looked up by name: one match is adopted; none or
// several leave the draft 'unknown' until an admin re-checks or discards it.
// A rejected step settles the draft 'failed' with Meta's code[:subcode] only.
// Tokens never leave the worker; Meta's error text is never kept.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { metaAdsConfig, metaAdsManageEnabled, missingScopes } from './config';
import { loadActiveConnectionTx, MetaAdsError, type MetaAdsActor } from './connection';
import {
  AD_FORMATS, createAd, createAdSet, createCampaign, createCreative, findCreatedByName, getPageInstagramAccount, getVideoStatus,
  createLeadForm, isMetaThrottle, isMetaTokenInvalid, LEAD_QUESTION_TYPES, listLeadForms, listPages, metaErrorCode, PLACEMENTS, uploadAdImage, uploadAdVideo, type AdFormat, type AdKind,
  searchTargeting, type CarouselCard, type Placement, type TargetInterest, type TargetingOption, type TargetingSearchType,
  type TargetPlace, type LeadFormInput, type LeadQuestionType,
} from './graph';

export const AD_CREATE_JOB = 'meta.ad_create';
/** Sends, then reads only: a throttle or a crash is retried, a step is never made twice. */
export const AD_CREATE_MAX_ATTEMPTS = 5;
export const AD_KINDS: readonly AdKind[] = ['whatsapp', 'instagram_direct', 'lead_form', 'website', 'messenger'];
/** Kinds that must run from the connected Page (its Instagram account, or its lead forms). */
const CONNECTED_PAGE_KINDS: readonly AdKind[] = ['instagram_direct', 'lead_form'];
export type DraftStatus = 'queued' | 'created' | 'failed' | 'unknown' | 'discarded';
export type DraftStep = 'campaign' | 'adset' | 'creative' | 'ad' | 'done';
const STEPS: Exclude<DraftStep, 'done'>[] = ['campaign', 'adset', 'creative', 'ad'];

/** Call-to-action buttons each kind may use (the first is the default). */
export const CTA_TYPES: Record<AdKind, readonly string[]> = {
  whatsapp: ['WHATSAPP_MESSAGE'],
  instagram_direct: ['INSTAGRAM_MESSAGE'],
  messenger: ['MESSAGE_PAGE'],
  lead_form: ['SIGN_UP', 'LEARN_MORE', 'APPLY_NOW', 'GET_QUOTE', 'SUBSCRIBE', 'DOWNLOAD'],
  website: ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'BOOK_TRAVEL', 'CONTACT_US', 'ORDER_NOW', 'GET_OFFER', 'APPLY_NOW', 'SUBSCRIBE', 'DOWNLOAD'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^\d{1,32}$/;
const COUNTRY = /^[A-Z]{2}$/;
const HASH = /^[0-9a-f]{16,64}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const DAY_MS = 86_400_000;
/** Largest budget accepted, in minor units (inside the column CHECK). */
export const MAX_DAILY_BUDGET_MINOR = 999_999_999_999_999;
/** Image bytes accepted for upload (Meta's own limit is larger; this keeps requests small). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface AdCreateInput {
  adAccountId: string;
  kind: AdKind;
  name: string;
  dailyBudgetMinor: number;
  startTime: string;
  endTime: string | null;
  countries: string[];
  ageMin: number;
  ageMax: number;
  genders: number[];
  primaryText: string;
  headline: string | null;
  description: string | null;
  linkUrl: string | null;
  leadFormId: string | null;
  ctaType: string;
  imageHash: string;
  imageUrl: string | null;
  whatsappNumber: string | null;
  welcomeMessage: string | null;
  publish: boolean;
  /** Bodhinox audience ids (meta_audiences) the ad reaches / leaves out; resolved to Meta ids on request. */
  audienceIds: string[];
  excludedAudienceIds: string[];
  format: AdFormat;
  videoId: string | null;
  cards: CarouselCard[] | null;
  /** Empty: Meta's automatic placements. */
  placements: Placement[];
  interests: TargetInterest[];
  places: TargetPlace[];
  locales: number[];
  /** A cost cap per result in minor units; null = Meta's lowest cost. */
  bidCapMinor: number | null;
  /** Another of the admin's Facebook Pages to run the ad from; null = the connected Page. */
  pageId: string | null;
}

/** Video files accepted for upload (one request to Meta; the proxy body limit in next.config.ts is 32 MB). */
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
/** WhatsApp Status runs click-to-WhatsApp and website ads only (Meta). */
const STATUS_KINDS: readonly AdKind[] = ['whatsapp', 'website'];
/** Carousels for the kinds whose card links Meta documents (Instagram Direct uses one image or a video). */
const CAROUSEL_KINDS: readonly AdKind[] = ['whatsapp', 'lead_form', 'website'];

const nameOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() && value.trim().length <= 200 ? value.trim() : null);

/** Interests, places and languages chosen from Meta's targeting search; null when malformed. */
function targetingLists(b: Record<string, unknown>): Pick<AdCreateInput, 'interests' | 'places' | 'locales' | 'placements'> | null {
  const list = (value: unknown, max: number) => (value === undefined || value === null ? [] : Array.isArray(value) && value.length <= max ? value : null);
  const rawInterests = list(b.interests, 25), rawPlaces = list(b.places, 25), rawLocales = list(b.locales, 10), rawPlacements = list(b.placements, 5);
  if (!rawInterests || !rawPlaces || !rawLocales || !rawPlacements) return null;
  const interests: TargetInterest[] = [];
  for (const i of rawInterests) {
    const r = i as Record<string, unknown> | null;
    const name = nameOf(r?.name);
    if (!r || typeof r.id !== 'string' || !META_ID.test(r.id) || !name) return null;
    if (!interests.some((x) => x.id === r.id)) interests.push({ id: r.id, name });
  }
  const places: TargetPlace[] = [];
  for (const p of rawPlaces) {
    const r = p as Record<string, unknown> | null;
    const name = nameOf(r?.name);
    const countryCode = r?.countryCode === null || r?.countryCode === undefined ? null : typeof r.countryCode === 'string' && COUNTRY.test(r.countryCode) ? r.countryCode : undefined;
    if (!r || (r.type !== 'region' && r.type !== 'city') || typeof r.key !== 'string' || !META_ID.test(r.key) || !name || countryCode === undefined) return null;
    if (!places.some((x) => x.type === r.type && x.key === r.key)) places.push({ type: r.type, key: r.key, name, countryCode });
  }
  if (!rawLocales.every((l) => typeof l === 'number' && Number.isInteger(l) && l > 0 && l < 100_000)) return null;
  if (!rawPlacements.every((p) => typeof p === 'string' && (PLACEMENTS as readonly string[]).includes(p))) return null;
  return { interests, places, locales: [...new Set(rawLocales as number[])], placements: [...new Set(rawPlacements as Placement[])] };
}

const text = (value: unknown, max: number, min = 0): string | null => {
  if (value === undefined || value === null) return min ? null : '';
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length >= min && v.length <= max ? v : null;
};
const optional = (value: unknown, max: number): string | null | undefined => {
  if (value === undefined || value === null || value === '') return null;
  const v = text(value, max, 1);
  return v === null ? undefined : v;
};
const httpsLink = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !!url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
};

/** Up to 10 distinct audience ids; null when malformed. */
const uuidList = (value: unknown): string[] | null => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10 || !value.every((v) => typeof v === 'string' && UUID.test(v))) return null;
  return [...new Set(value.map((v: string) => v.toLowerCase()))];
};

/** A validated create request, or null (400). Times are ISO strings; a start in the past starts now. */
export function parseAdCreateInput(body: unknown, now: number = Date.now()): AdCreateInput | null {
  if (!body || typeof body !== 'object') return null;
  let b = body as Record<string, unknown>;
  const kind = b.kind as AdKind;
  if (!AD_KINDS.includes(kind)) return null;
  if (typeof b.adAccountId !== 'string' || !META_ID.test(b.adAccountId)) return null;
  const adAccountId = b.adAccountId;
  const name = text(b.name, 200, 1);
  const primaryText = text(b.primaryText, 2000, 1);
  const headline = optional(b.headline, 255);
  const description = optional(b.description, 255);
  if (!name || !primaryText || headline === undefined || description === undefined) return null;
  const budget = b.dailyBudgetMinor;
  if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget <= 0 || budget > MAX_DAILY_BUDGET_MINOR) return null;

  const startMs = typeof b.startTime === 'string' ? Date.parse(b.startTime) : now;
  if (!Number.isFinite(startMs) || startMs > now + 365 * DAY_MS) return null;
  const start = Math.max(startMs, now);
  let end: number | null = null;
  if (b.endTime !== undefined && b.endTime !== null && b.endTime !== '') {
    end = typeof b.endTime === 'string' ? Date.parse(b.endTime) : NaN;
    // A daily budget needs a run longer than a day.
    if (!Number.isFinite(end) || end < start + DAY_MS || end > now + 2 * 365 * DAY_MS) return null;
  }

  const countries = Array.isArray(b.countries) ? [...new Set(b.countries.map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : '')))] : [];
  if (!countries.length || countries.length > 25 || !countries.every((c) => COUNTRY.test(c))) return null;
  const ageMin = b.ageMin === undefined ? 18 : b.ageMin;
  const ageMax = b.ageMax === undefined ? 65 : b.ageMax;
  if (typeof ageMin !== 'number' || typeof ageMax !== 'number' || !Number.isInteger(ageMin) || !Number.isInteger(ageMax)
    || ageMin < 18 || ageMax > 65 || ageMin > ageMax) return null;
  const genders = Array.isArray(b.genders) ? [...new Set(b.genders)] : [];
  if (!genders.every((g) => g === 1 || g === 2)) return null;

  const cta = typeof b.ctaType === 'string' && b.ctaType ? b.ctaType : CTA_TYPES[kind][0];
  if (!CTA_TYPES[kind].includes(cta)) return null;
  if (b.format === 'carousel' && Array.isArray(b.cards) && b.imageHash === undefined) b = { ...b, imageHash: (b.cards[0] as { imageHash?: unknown } | undefined)?.imageHash };
  if (typeof b.imageHash !== 'string' || !HASH.test(b.imageHash)) return null;
  const imageUrl = b.imageUrl === undefined || b.imageUrl === null || b.imageUrl === '' ? null : httpsLink(b.imageUrl);
  if (b.imageUrl && !imageUrl) return null;

  const linkUrl = kind === 'website' ? httpsLink(b.linkUrl) : null;
  if (kind === 'website' && !linkUrl) return null;
  const leadFormId = kind === 'lead_form' && typeof b.leadFormId === 'string' && META_ID.test(b.leadFormId) ? b.leadFormId : null;
  if (kind === 'lead_form' && !leadFormId) return null;
  let whatsappNumber: string | null = null;
  if (kind === 'whatsapp' && b.whatsappNumber) {
    const digits = typeof b.whatsappNumber === 'string' ? b.whatsappNumber.replace(/[\s()-]/g, '') : '';
    whatsappNumber = digits.startsWith('+') ? digits : `+${digits}`;
    if (!E164.test(whatsappNumber)) return null;
  }
  const welcome = kind === 'whatsapp' ? optional(b.welcomeMessage, 300) : null;
  if (welcome === undefined) return null;
  const targeting = targetingLists(b);
  if (!targeting) return null;
  if (targeting.placements.includes('whatsapp_status') && !STATUS_KINDS.includes(kind)) return null;
  const format = (b.format === undefined ? 'image' : b.format) as AdFormat;
  if (!AD_FORMATS.includes(format)) return null;
  const videoId = format === 'video' && typeof b.videoId === 'string' && META_ID.test(b.videoId) ? b.videoId : null;
  if (format === 'video' && !videoId) return null;
  let cards: CarouselCard[] | null = null;
  if (format === 'carousel') {
    if (!CAROUSEL_KINDS.includes(kind) || !Array.isArray(b.cards) || b.cards.length < 2 || b.cards.length > 10) return null;
    cards = [];
    for (const c of b.cards) {
      const r = c as Record<string, unknown> | null;
      const cardHeadline = r ? optional(r.headline, 255) : undefined;
      const cardDescription = r ? optional(r.description, 255) : undefined;
      if (!r || typeof r.imageHash !== 'string' || !HASH.test(r.imageHash) || cardHeadline === undefined || cardDescription === undefined) return null;
      // Website cards may each open their own page; other kinds share the ad's destination.
      const cardLink = kind === 'website' && r.link ? httpsLink(r.link) : null;
      if (kind === 'website' && r.link && !cardLink) return null;
      cards.push({ imageHash: r.imageHash, headline: cardHeadline, description: cardDescription, link: cardLink });
    }
  }
  let bidCapMinor: number | null = null;
  if (b.bidCapMinor !== undefined && b.bidCapMinor !== null) {
    if (typeof b.bidCapMinor !== 'number' || !Number.isSafeInteger(b.bidCapMinor) || b.bidCapMinor <= 0 || b.bidCapMinor > budget) return null;
    bidCapMinor = b.bidCapMinor;
  }
  let pageId: string | null = null;
  if (b.pageId !== undefined && b.pageId !== null && b.pageId !== '') {
    if (typeof b.pageId !== 'string' || !META_ID.test(b.pageId)) return null;
    pageId = b.pageId;
  }
  const audienceIds = uuidList(b.audienceIds);
  const excludedAudienceIds = uuidList(b.excludedAudienceIds);
  if (!audienceIds || !excludedAudienceIds || audienceIds.some((a) => excludedAudienceIds.includes(a))) return null;

  return {
    adAccountId, kind, name, dailyBudgetMinor: budget,
    startTime: new Date(start).toISOString(), endTime: end === null ? null : new Date(end).toISOString(),
    countries, ageMin, ageMax, genders: genders as number[], primaryText, headline, description, linkUrl, leadFormId,
    ctaType: cta, imageHash: b.imageHash, imageUrl, whatsappNumber, welcomeMessage: welcome, publish: b.publish === true,
    audienceIds, excludedAudienceIds, format, videoId, cards, ...targeting, bidCapMinor, pageId,
  };
}

export interface AdDraftDto {
  id: string;
  adAccountId: string;
  kind: AdKind;
  name: string;
  dailyBudget: number;
  currency: string | null;
  publish: boolean;
  status: DraftStatus;
  step: DraftStep;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  lastErrorCode: string | null;
  imageUrl: string | null;
  createdAt: string;
  completedAt: string | null;
  /** The draft this one is an A/B variant of. */
  variantOf: string | null;
  /** The Meta ad this one replaces (paused once this one exists). */
  replacesAdId: string | null;
  pageId: string;
}

interface DraftRow {
  id: string; ad_account_id: string; page_id: string; kind: AdKind; name: string; daily_budget_minor: bigint; currency: string | null;
  start_time: Date; end_time: Date | null; countries: string[]; age_min: number; age_max: number; genders: number[];
  primary_text: string; headline: string | null; description: string | null; link_url: string | null; lead_form_id: string | null;
  cta_type: string; image_hash: string; image_url: string | null; whatsapp_number: string | null; welcome_message: string | null;
  publish: boolean; status: DraftStatus; step: DraftStep; campaign_id: string | null; adset_id: string | null;
  creative_id: string | null; ad_id: string | null; last_error_code: string | null; created_at: Date; completed_at: Date | null;
  audience_ids: string[]; excluded_audience_ids: string[];
  format: AdFormat; video_id: string | null; cards: CarouselCard[] | null; placements: Placement[]; interests: TargetInterest[];
  places: TargetPlace[]; locales: number[]; variant_of: string | null; bid_cap_minor: bigint | null; replaces_ad_id: string | null;
}

const draftDto = (r: DraftRow): AdDraftDto => ({
  id: r.id, adAccountId: r.ad_account_id, kind: r.kind, name: r.name, dailyBudget: Number(r.daily_budget_minor), currency: r.currency,
  publish: r.publish, status: r.status, step: r.step, campaignId: r.campaign_id, adsetId: r.adset_id, adId: r.ad_id,
  lastErrorCode: r.last_error_code, imageUrl: r.image_url, createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null, variantOf: r.variant_of,
  replacesAdId: r.replaces_ad_id, pageId: r.page_id,
});

const DRAFT_COLUMNS = `id::text AS id, ad_account_id, page_id, kind, name, daily_budget_minor, currency, start_time, end_time,
  countries, age_min, age_max, genders, primary_text, headline, description, link_url, lead_form_id, cta_type, image_hash,
  image_url, whatsapp_number, welcome_message, publish, status, step, campaign_id, adset_id, creative_id, ad_id,
  last_error_code, created_at, completed_at, audience_ids, excluded_audience_ids, format, video_id, cards, placements, interests,
  places, locales, variant_of::text AS variant_of, bid_cap_minor, replaces_ad_id`;

const raw = (sql: string) => Prisma.raw(sql);

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>, userId?: string) =>
  withTenant({ accountId, userId, role: 'owner' }, work, getWorkerPrisma());

const audit = (tx: TenantTransaction, actor: MetaAdsActor, action: string, resourceId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;

/** Creating ads needs ads_management and pages_manage_ads on the grant. */
const CREATE_SCOPES = ['ads_management', 'pages_manage_ads'] as const;
export const missingCreateScopes = (scopes: readonly string[]) => [
  ...missingScopes(scopes, 'manage'),
  ...CREATE_SCOPES.filter((s) => s !== 'ads_management' && !scopes.includes(s)),
];

function requireCreator(actor: MetaAdsActor): void {
  if (!metaAdsConfig()) throw new MetaAdsError('meta_ads_not_enabled');
  if (!metaAdsManageEnabled()) throw new MetaAdsError('manage_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
}

/** Bodhinox audience ids to Meta ids: each must be ready in the same ad account, or the request is refused. */
async function resolveAudiencesTx(tx: TenantTransaction, accountId: string, adAccountId: string, include: string[],
  exclude: string[]): Promise<{ include: string[]; exclude: string[] }> {
  const wanted = [...include, ...exclude];
  if (!wanted.length) return { include: [], exclude: [] };
  const rows = await tx.$queryRaw<{ id: string; meta_audience_id: string }[]>`SELECT id::text AS id, meta_audience_id FROM meta_audiences
    WHERE account_id=${accountId}::uuid AND ad_account_id=${adAccountId} AND status='ready' AND meta_audience_id IS NOT NULL
      AND id = ANY(${wanted}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r.meta_audience_id]));
  if (wanted.some((w) => !byId.has(w))) throw new MetaAdsError('invalid_choice');
  return { include: include.map((i) => byId.get(i)!), exclude: exclude.map((i) => byId.get(i)!) };
}

/** Records the draft and queues its creation (admin). */
export async function requestAdCreate(actor: MetaAdsActor, input: AdCreateInput): Promise<AdDraftDto> {
  requireCreator(actor);
  const pageId = input.pageId ? await checkedPage(actor, input.pageId, input.kind) : null;
  return worker(actor.accountId, async (tx) => {
    const [conn] = await tx.$queryRaw<{ id: string; status: string; page_id: string | null; scopes: string[]; max_daily_budget_minor: bigint | null }[]>`
      SELECT id::text AS id, status, page_id, scopes, max_daily_budget_minor FROM meta_ad_connections
      WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' LIMIT 1 FOR UPDATE`;
    if (!conn) throw new MetaAdsError('not_connected');
    if (conn.status === 'token_invalid') throw new MetaAdsError('token_invalid');
    if (conn.status !== 'active' || !conn.page_id) throw new MetaAdsError('not_connected');
    if (missingCreateScopes(conn.scopes).length) throw new MetaAdsError('missing_scope');
    const [account] = await tx.$queryRaw<{ currency: string | null }[]>`SELECT currency FROM meta_ad_accounts
      WHERE account_id=${actor.accountId}::uuid AND connection_id=${conn.id}::uuid AND ad_account_id=${input.adAccountId}`;
    if (!account) throw new MetaAdsError('invalid_choice');
    const cap = conn.max_daily_budget_minor === null ? null : Number(conn.max_daily_budget_minor);
    if (cap !== null && input.dailyBudgetMinor > cap) throw new MetaAdsError('over_budget_cap');
    const audiences = await resolveAudiencesTx(tx, actor.accountId, input.adAccountId, input.audienceIds, input.excludedAudienceIds);
    const [row] = await tx.$queryRaw<DraftRow[]>`
      INSERT INTO meta_ad_drafts(account_id, connection_id, ad_account_id, page_id, kind, name, daily_budget_minor, currency,
        start_time, end_time, countries, age_min, age_max, genders, primary_text, headline, description, link_url, lead_form_id,
        cta_type, image_hash, image_url, whatsapp_number, welcome_message, publish, requested_by, audience_ids, excluded_audience_ids,
        format, video_id, cards, placements, interests, places, locales, bid_cap_minor)
      VALUES(${actor.accountId}::uuid, ${conn.id}::uuid, ${input.adAccountId}, ${pageId ?? conn.page_id}, ${input.kind}, ${input.name},
        ${input.dailyBudgetMinor}, ${account.currency}, ${input.startTime}::timestamptz, ${input.endTime}::timestamptz,
        ${input.countries}::text[], ${input.ageMin}, ${input.ageMax}, ${input.genders}::int[], ${input.primaryText},
        ${input.headline}, ${input.description}, ${input.linkUrl}, ${input.leadFormId}, ${input.ctaType}, ${input.imageHash},
        ${input.imageUrl}, ${input.whatsappNumber}, ${input.welcomeMessage}, ${input.publish}, ${actor.userId}::uuid,
        ${audiences.include}::text[], ${audiences.exclude}::text[], ${input.format}, ${input.videoId},
        ${input.cards ? JSON.stringify(input.cards) : null}::jsonb, ${input.placements}::text[], ${JSON.stringify(input.interests)}::jsonb,
        ${JSON.stringify(input.places)}::jsonb, ${input.locales}::int[], ${input.bidCapMinor}::bigint)
      RETURNING ${raw(DRAFT_COLUMNS)}`;
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${AD_CREATE_JOB},${actor.accountId}::uuid,${JSON.stringify({ draftId: row.id })}::jsonb,${`adcreate:${row.id}`},
        ${AD_CREATE_MAX_ATTEMPTS})`;
    await audit(tx, actor, 'meta_ads.ad_create_request', row.id, {
      adAccountId: input.adAccountId, kind: input.kind, dailyBudgetMinor: input.dailyBudgetMinor, publish: input.publish,
      ...(pageId ? { pageId } : {}), ...(input.bidCapMinor ? { bidCapMinor: input.bidCapMinor } : {}),
    });
    return draftDto(row);
  }, actor.userId);
}


/** The latest drafts (any member; app-role read). */
export async function listAdDrafts(actor: MetaAdsActor): Promise<AdDraftDto[]> {
  return withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const rows = await tx.$queryRaw<DraftRow[]>`SELECT ${raw(DRAFT_COLUMNS)} FROM meta_ad_drafts
      WHERE account_id=${actor.accountId}::uuid ORDER BY created_at DESC LIMIT 20`;
    return rows.map(draftDto);
  });
}

// ---------------------------------------------------------------------------
// The job

const stepName = (draft: DraftRow, step: Exclude<DraftStep, 'done'>) =>
  step === 'adset' ? `${draft.name} · ad set` : step === 'creative' ? `${draft.name} · creative ${draft.id.slice(0, 8)}` : draft.name;

const lookup = (draft: DraftRow, step: Exclude<DraftStep, 'done'>) => {
  switch (step) {
    case 'campaign': return { edge: 'campaigns' as const, parent: draft.ad_account_id };
    case 'adset': return draft.campaign_id ? { edge: 'adsets' as const, parent: draft.campaign_id } : null;
    case 'creative': return { edge: 'adcreatives' as const, parent: draft.ad_account_id };
    case 'ad': return draft.adset_id ? { edge: 'ads' as const, parent: draft.adset_id } : null;
  }
};

const ID_COLUMN = { campaign: 'campaign_id', adset: 'adset_id', creative: 'creative_id', ad: 'ad_id' } as const;
const nextStep = (step: Exclude<DraftStep, 'done'>): DraftStep => STEPS[STEPS.indexOf(step) + 1] ?? 'done';

async function saveStep(accountId: string, draftId: string, step: Exclude<DraftStep, 'done'>, objectId: string): Promise<void> {
  const following = nextStep(step);
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_drafts SET
      ${raw(ID_COLUMN[step])}=${objectId}, step=${following},
      status=CASE WHEN ${following}::text = 'done' THEN 'created' ELSE status END,
      completed_at=CASE WHEN ${following}::text = 'done' THEN now() ELSE completed_at END,
      last_error_code=NULL, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${draftId}::uuid AND step=${step}`);
  if (following === 'done') {
    await pauseReplaced(accountId, draftId);
    // Show the new ad in Bodhinox right away.
    await worker(accountId, (tx) => tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts) VALUES
        ('meta.ad_objects_sync',${accountId}::uuid,'{}'::jsonb,${`meta-ad-objects-created:${draftId}`},3)
      ON CONFLICT(dedupe_key) DO NOTHING`);
  }
}

/**
 * A finished replacement pauses the ad it replaces, through the change
 * pipeline (one intent, read-back), as the admin who asked while they are
 * still an admin. Never throws: the new ad is made either way, and a pause that
 * cannot be queued (already paused, a change open, not synced yet) is left to
 * the admin.
 */
async function pauseReplaced(accountId: string, draftId: string): Promise<void> {
  try {
    const [row] = await worker(accountId, (tx) => tx.$queryRaw<{ replaces_ad_id: string | null; requested_by: string; admin: boolean }[]>`
      SELECT d.replaces_ad_id, d.requested_by::text AS requested_by,
        EXISTS (SELECT 1 FROM account_memberships m WHERE m.account_id=d.account_id AND m.user_id=d.requested_by
          AND m.role IN ('owner','admin')) AS admin
      FROM meta_ad_drafts d WHERE d.account_id=${accountId}::uuid AND d.id=${draftId}::uuid`);
    if (!row?.replaces_ad_id || !row.admin) return;
    // Imported here: manage.ts reaches the job schedule, which must not load this module first.
    const { requestAdChange } = await import('./manage');
    await requestAdChange({ accountId, userId: row.requested_by, role: 'admin' }, { objectId: row.replaces_ad_id, field: 'status', value: 'PAUSED' });
  } catch (error) {
    console.error('[meta-ads] replaced ad not paused', error instanceof MetaAdsError ? error.code : error instanceof Error ? error.name : 'unknown');
  }
}

async function settle(accountId: string, draftId: string, status: 'failed' | 'unknown', code: string | null): Promise<void> {
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_drafts SET status=${status}, last_error_code=${code},
      updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${draftId}::uuid AND status IN ('queued','unknown')`);
}

const errorCode = (error: unknown): string | null => {
  const code = metaErrorCode(error);
  return code && /^[0-9:]{1,40}$/.test(code) ? code : error instanceof MetaApiError ? String(error.httpStatus).slice(0, 40) : null;
};

/** After an unclear send: one object with the step's name is adopted; none or several leave it unknown. */
async function readBack(accountId: string, draft: DraftRow, step: Exclude<DraftStep, 'done'>, token: string): Promise<'adopted' | 'unknown'> {
  const where = lookup(draft, step);
  if (!where) return 'unknown';
  const ids = await findCreatedByName(where.edge, where.parent, token, stepName(draft, step), draft.created_at);
  if (ids.length !== 1) return 'unknown';
  await saveStep(accountId, draft.id, step, ids[0]);
  return 'adopted';
}

async function send(draft: DraftRow, step: Exclude<DraftStep, 'done'>, token: string, instagramUserId: string | null): Promise<{ id: string }> {
  const status = draft.publish ? 'ACTIVE' : 'PAUSED';
  switch (step) {
    case 'campaign':
      return createCampaign(draft.ad_account_id, token, { name: stepName(draft, step), kind: draft.kind, status });
    case 'adset':
      return createAdSet(draft.ad_account_id, token, {
        name: stepName(draft, step), campaignId: draft.campaign_id!, kind: draft.kind, pageId: draft.page_id,
        dailyBudgetMinor: Number(draft.daily_budget_minor), startTime: draft.start_time.toISOString(),
        endTime: draft.end_time?.toISOString() ?? null, countries: draft.countries, ageMin: draft.age_min, ageMax: draft.age_max,
        genders: draft.genders, whatsappNumber: draft.whatsapp_number, status,
        audienceIds: draft.audience_ids, excludedAudienceIds: draft.excluded_audience_ids,
        placements: draft.placements, places: draft.places, interests: draft.interests, locales: draft.locales,
        bidCapMinor: draft.bid_cap_minor === null ? null : Number(draft.bid_cap_minor),
      });
    case 'creative':
      return createCreative(draft.ad_account_id, token, {
        name: stepName(draft, step), kind: draft.kind, pageId: draft.page_id, instagramUserId, primaryText: draft.primary_text,
        headline: draft.headline, description: draft.description, imageHash: draft.image_hash, linkUrl: draft.link_url,
        leadFormId: draft.lead_form_id, ctaType: draft.cta_type, welcomeMessage: draft.welcome_message,
        format: draft.format, videoId: draft.video_id, cards: draft.cards,
      });
    case 'ad':
      return createAd(draft.ad_account_id, token, { name: stepName(draft, step), adsetId: draft.adset_id!, creativeId: draft.creative_id!, status });
  }
}

/** meta.ad_create: runs the draft's remaining steps. */
export async function handleAdCreateJob(accountId: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  const draftId = typeof payload.draftId === 'string' && UUID.test(payload.draftId) ? payload.draftId : null;
  if (!draftId) throw new Error('Invalid ad create job');
  const lastAttempt = !!attempt && attempt.maxAttempts > 1 && attempt.attempts >= attempt.maxAttempts;

  for (let guard = 0; guard < STEPS.length; guard++) {
    const state = await worker(accountId, async (tx) => {
      const [draft] = await tx.$queryRaw<DraftRow[]>`SELECT ${raw(DRAFT_COLUMNS)} FROM meta_ad_drafts
        WHERE account_id=${accountId}::uuid AND id=${draftId}::uuid`;
      if (!draft || draft.status !== 'queued' || draft.step === 'done') return null;
      const step = draft.step as Exclude<DraftStep, 'done'>;
      const [intent] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM outbound_intents
        WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:adcreate:${draftId}:${step}`}`;
      const conn = await loadActiveConnectionTx(tx, accountId);
      return { draft, step, intent: intent?.status ?? null, conn };
    });
    if (!state) return;
    const { draft, step, intent, conn } = state;
    const key = `adcreate:${draftId}:${step}`;
    // 'dispatching' or 'unknown': a send may have reached Meta. 'accepted': dispatchOnce returns its result.
    const claimed = intent === 'dispatching' || intent === 'unknown';
    if (!conn?.userToken) return settle(accountId, draftId, claimed ? 'unknown' : 'failed', 'not_connected');
    const token = conn.userToken;
    if (claimed) {
      try {
        if ((await readBack(accountId, draft, step, token)) === 'adopted') continue;
        return settle(accountId, draftId, 'unknown', null);
      } catch (error) {
        console.error('[meta-ads] ad create read-back failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
        if (!lastAttempt && !isMetaTokenInvalid(error)) throw error;
        return settle(accountId, draftId, 'unknown', null);
      }
    }
    // Every earlier attempt failed before claiming a send: the last attempt never starts one.
    if (lastAttempt && intent !== 'accepted') return settle(accountId, draftId, 'failed', 'attempts_exhausted');
    if (!metaAdsManageEnabled() || missingCreateScopes(conn.scopes).length) return settle(accountId, draftId, 'failed', 'missing_scope');

    if (step === 'creative' && draft.format === 'video' && draft.video_id) {
      let video: 'ready' | 'processing' | 'error';
      try {
        video = await getVideoStatus(draft.video_id, token);
      } catch (error) {
        if (isMetaTokenInvalid(error) || lastAttempt) return settle(accountId, draftId, 'failed', errorCode(error) ?? 'video_not_ready');
        throw error;
      }
      if (video === 'error') return settle(accountId, draftId, 'failed', 'video_error');
      // Still processing: nothing was sent; the job retries later.
      if (video === 'processing') {
        if (lastAttempt) return settle(accountId, draftId, 'failed', 'video_not_ready');
        throw new Error('Meta is still processing the video');
      }
    }
    try {
      let instagramUserId: string | null = null;
      if (step === 'creative' && draft.kind === 'instagram_direct') {
        instagramUserId = await getPageInstagramAccount(draft.page_id, token);
        if (!instagramUserId) return settle(accountId, draftId, 'failed', 'instagram_not_linked');
      }
      const result = await dispatchOnce(accountId, key, () => send(draft, step, token, instagramUserId), { retryRejected: true });
      await saveStep(accountId, draftId, step, result.id);
      continue;
    } catch (error) {
      if (error instanceof UncertainDispatchError) {
        console.error('[meta-ads] ad create outcome unknown; looking it up');
        try {
          if ((await readBack(accountId, draft, step, token)) === 'adopted') continue;
        } catch (lookupError) {
          console.error('[meta-ads] ad create read-back failed', metaErrorCode(lookupError) ?? 'unknown');
          if (!lastAttempt && !isMetaTokenInvalid(lookupError)) throw lookupError;
        }
        return settle(accountId, draftId, 'unknown', null);
      }
      if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
        const code = errorCode(error);
        console.error('[meta-ads] ad create rejected', { step, code });
        // Rejected: nothing was made; the intent is 'failed' and a later attempt may claim it again.
        if (isMetaThrottle(error) && attempt && attempt.attempts < attempt.maxAttempts - 1) throw error;
        if (isMetaTokenInvalid(error)) {
          await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_connections SET status='token_invalid',
              last_error_code=${code}, updated_at=now()
            WHERE account_id=${accountId}::uuid AND id=${conn.id}::uuid AND status='active'`);
        }
        return settle(accountId, draftId, 'failed', code);
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Admin follow-ups

async function adminDraft(actor: MetaAdsActor, draftId: string): Promise<DraftRow> {
  requireCreator(actor);
  if (!UUID.test(draftId)) throw new MetaAdsError('not_found');
  const [row] = await worker(actor.accountId, (tx) => tx.$queryRaw<DraftRow[]>`SELECT ${raw(DRAFT_COLUMNS)} FROM meta_ad_drafts
    WHERE account_id=${actor.accountId}::uuid AND id=${draftId}::uuid`, actor.userId);
  if (!row) throw new MetaAdsError('not_found');
  return row;
}

/**
 * An 'unknown' draft: looks the unclear step's object up again (a read). One
 * match is adopted and the remaining steps are queued; otherwise it stays
 * unknown for the admin to check in Ads Manager or discard.
 */
export async function recheckAdDraft(actor: MetaAdsActor, draftId: string): Promise<AdDraftDto> {
  const draft = await adminDraft(actor, draftId);
  if (draft.status !== 'unknown' || draft.step === 'done') return draftDto(draft);
  const conn = await worker(actor.accountId, (tx) => loadActiveConnectionTx(tx, actor.accountId), actor.userId);
  if (!conn?.userToken) throw new MetaAdsError('not_connected');
  const step = draft.step as Exclude<DraftStep, 'done'>;
  let found: string[];
  try {
    const where = lookup(draft, step);
    found = where ? await findCreatedByName(where.edge, where.parent, conn.userToken, stepName(draft, step), draft.created_at) : [];
  } catch (error) {
    console.error('[meta-ads] ad create re-check failed', metaErrorCode(error) ?? 'unknown');
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
  if (found.length === 1) {
    await worker(actor.accountId, async (tx) => {
      const following = nextStep(step);
      await tx.$executeRaw`UPDATE meta_ad_drafts SET ${raw(ID_COLUMN[step])}=${found[0]}, step=${following},
          status=CASE WHEN ${following}::text = 'done' THEN 'created' ELSE 'queued' END,
          completed_at=CASE WHEN ${following}::text = 'done' THEN now() ELSE completed_at END, last_error_code=NULL, updated_at=now()
        WHERE account_id=${actor.accountId}::uuid AND id=${draftId}::uuid AND status='unknown' AND step=${step}`;
      if (following !== 'done') {
        await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
          VALUES(${AD_CREATE_JOB},${actor.accountId}::uuid,${JSON.stringify({ draftId })}::jsonb,
            ${`adcreate:${draftId}:resume:${step}`},${AD_CREATE_MAX_ATTEMPTS})
          ON CONFLICT(dedupe_key) DO NOTHING`;
      }
      await audit(tx, actor, 'meta_ads.ad_create_recheck', draftId, { step, adopted: true });
    }, actor.userId);
  }
  return draftDto(await adminDraft(actor, draftId));
}

/** Gives up on a failed or unknown draft (admin). What Meta already made stays there, paused or as chosen. */
export async function discardAdDraft(actor: MetaAdsActor, draftId: string): Promise<AdDraftDto> {
  const draft = await adminDraft(actor, draftId);
  if (draft.status !== 'unknown' && draft.status !== 'failed') return draftDto(draft);
  await worker(actor.accountId, async (tx) => {
    await tx.$executeRaw`UPDATE meta_ad_drafts SET status='discarded', resolved_by=${actor.userId}::uuid, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${draftId}::uuid AND status IN ('unknown','failed')`;
    await audit(tx, actor, 'meta_ads.ad_create_discard', draftId, { previousStatus: draft.status, step: draft.step });
  }, actor.userId);
  return draftDto(await adminDraft(actor, draftId));
}

// ---------------------------------------------------------------------------
// Images

/** JPEG or PNG by their first bytes (the browser's declared type is not trusted). */
/** MP4 / MOV (ISO base media: 'ftyp' at byte 4) by their first bytes only. */
export function isAdVideo(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

/** Uploads a video to a linked ad account's library (admin); the ad uses its id. */
export async function uploadVideoForAd(actor: MetaAdsActor, adAccountId: string, bytes: Uint8Array, name: string): Promise<{ id: string }> {
  requireCreator(actor);
  if (!META_ID.test(adAccountId)) throw new MetaAdsError('invalid_choice');
  const conn = await worker(actor.accountId, async (tx) => {
    const c = await loadActiveConnectionTx(tx, actor.accountId);
    if (!c) return null;
    const [linked] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM meta_ad_accounts
      WHERE account_id=${actor.accountId}::uuid AND connection_id=${c.id}::uuid AND ad_account_id=${adAccountId}`;
    return linked?.n ? c : 'unlinked';
  }, actor.userId);
  if (conn === 'unlinked') throw new MetaAdsError('invalid_choice');
  if (!conn?.userToken) throw new MetaAdsError('not_connected');
  if (missingCreateScopes(conn.scopes).length) throw new MetaAdsError('missing_scope');
  try {
    return await uploadAdVideo(adAccountId, conn.userToken, bytes, name);
  } catch (error) {
    console.error('[meta-ads] video upload failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
}

export function isAdImage(bytes: Uint8Array): boolean {
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return jpeg || png;
}

/**
 * Uploads an ad image to a linked ad account's library (admin). Meta stores it
 * by content hash, so sending the same bytes twice is harmless: this is a plain
 * synchronous call, no intent needed.
 */
export async function uploadImageForAd(actor: MetaAdsActor, adAccountId: string, bytes: Buffer, name: string): Promise<{ hash: string; url: string | null }> {
  requireCreator(actor);
  if (!META_ID.test(adAccountId)) throw new MetaAdsError('invalid_choice');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new MetaAdsError('invalid_request');
  const conn = await worker(actor.accountId, async (tx) => {
    const c = await loadActiveConnectionTx(tx, actor.accountId);
    if (!c) return null;
    const [linked] = await tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM meta_ad_accounts
      WHERE account_id=${actor.accountId}::uuid AND connection_id=${c.id}::uuid AND ad_account_id=${adAccountId}`;
    return linked ? c : 'unlinked';
  }, actor.userId);
  if (conn === null || !conn) throw new MetaAdsError('not_connected');
  if (conn === 'unlinked') throw new MetaAdsError('invalid_choice');
  if (!conn.userToken) throw new MetaAdsError('not_connected');
  try {
    return await uploadAdImage(adAccountId, conn.userToken, bytes.toString('base64'), name.replace(/[^\w.-]/g, '_').slice(0, 100) || 'image');
  } catch (error) {
    console.error('[meta-ads] ad image upload failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
}

/**
 * Meta's targeting search for the Create ad dialog (admin): interests,
 * cities/regions or languages matching `query`. A read with the stored login;
 * the token never reaches the browser.
 */
export async function searchAdTargeting(actor: MetaAdsActor, type: TargetingSearchType, query: string): Promise<TargetingOption[]> {
  requireCreator(actor);
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  const conn = await worker(actor.accountId, (tx) => loadActiveConnectionTx(tx, actor.accountId), actor.userId);
  if (!conn?.userToken) throw new MetaAdsError('not_connected');
  try {
    return await searchTargeting(type, q, conn.userToken);
  } catch (error) {
    console.error('[meta-ads] targeting search failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
}

// ---------------------------------------------------------------------------
// Duplicate and A/B variant (admin)

/** The connection checks every new ad needs, inside the caller's worker transaction. */
async function lockCreatorConnectionTx(tx: TenantTransaction, accountId: string): Promise<{ id: string; max_daily_budget_minor: bigint | null }> {
  const [conn] = await tx.$queryRaw<{ id: string; status: string; page_id: string | null; scopes: string[]; max_daily_budget_minor: bigint | null }[]>`
    SELECT id::text AS id, status, page_id, scopes, max_daily_budget_minor FROM meta_ad_connections
    WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1 FOR UPDATE`;
  if (!conn) throw new MetaAdsError('not_connected');
  if (conn.status === 'token_invalid') throw new MetaAdsError('token_invalid');
  if (conn.status !== 'active' || !conn.page_id) throw new MetaAdsError('not_connected');
  if (missingCreateScopes(conn.scopes).length) throw new MetaAdsError('missing_scope');
  return conn;
}

const queueCreateTx = (tx: TenantTransaction, accountId: string, draftId: string) =>
  tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
    VALUES(${AD_CREATE_JOB},${accountId}::uuid,${JSON.stringify({ draftId })}::jsonb,${`adcreate:${draftId}`},${AD_CREATE_MAX_ATTEMPTS})`;

/**
 * A paused copy of a draft as a new campaign, ad set and ad (same goal,
 * audience, budget and creative). A start in the past starts now; an end less
 * than a day away is dropped. The workspace budget cap still applies.
 */
export async function duplicateAdDraft(actor: MetaAdsActor, sourceId: string): Promise<AdDraftDto> {
  requireCreator(actor);
  if (!UUID.test(sourceId)) throw new MetaAdsError('not_found');
  return worker(actor.accountId, async (tx) => {
    const conn = await lockCreatorConnectionTx(tx, actor.accountId);
    const [source] = await tx.$queryRaw<DraftRow[]>`SELECT ${raw(DRAFT_COLUMNS)} FROM meta_ad_drafts
      WHERE account_id=${actor.accountId}::uuid AND id=${sourceId}::uuid`;
    if (!source) throw new MetaAdsError('not_found');
    const cap = conn.max_daily_budget_minor === null ? null : Number(conn.max_daily_budget_minor);
    if (cap !== null && Number(source.daily_budget_minor) > cap) throw new MetaAdsError('over_budget_cap');
    const name = `${source.name} (copy)`.slice(0, 200);
    const [row] = await tx.$queryRaw<DraftRow[]>`
      INSERT INTO meta_ad_drafts(account_id, connection_id, ad_account_id, page_id, kind, name, daily_budget_minor, currency,
        start_time, end_time, countries, age_min, age_max, genders, primary_text, headline, description, link_url, lead_form_id,
        cta_type, image_hash, image_url, whatsapp_number, welcome_message, publish, requested_by, audience_ids, excluded_audience_ids,
        format, video_id, cards, placements, interests, places, locales)
      SELECT account_id, ${conn.id}::uuid, ad_account_id, page_id, kind, ${name}, daily_budget_minor, currency,
        greatest(start_time, now()), CASE WHEN end_time > greatest(start_time, now()) + interval '1 day' THEN end_time END,
        countries, age_min, age_max, genders, primary_text, headline, description, link_url, lead_form_id, cta_type, image_hash,
        image_url, whatsapp_number, welcome_message, false, ${actor.userId}::uuid, audience_ids, excluded_audience_ids, format,
        video_id, cards, placements, interests, places, locales
      FROM meta_ad_drafts WHERE account_id=${actor.accountId}::uuid AND id=${sourceId}::uuid
      RETURNING ${raw(DRAFT_COLUMNS)}`;
    await queueCreateTx(tx, actor.accountId, row.id);
    await audit(tx, actor, 'meta_ads.ad_duplicate', row.id, { sourceId });
    return draftDto(row);
  }, actor.userId);
}

export interface AdVariantInput {
  sourceId: string;
  name: string | null;
  primaryText: string;
  headline: string | null;
  description: string | null;
  imageHash: string;
  imageUrl: string | null;
  /** Pause the source ad once this one exists (an edit of a running ad). */
  replace: boolean;
}

export function parseAdVariantInput(body: unknown): AdVariantInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.sourceId !== 'string' || !UUID.test(b.sourceId)) return null;
  const name = optional(b.name, 200);
  const primaryText = text(b.primaryText, 2000, 1);
  const headline = optional(b.headline, 255);
  const description = optional(b.description, 255);
  if (name === undefined || !primaryText || headline === undefined || description === undefined) return null;
  if (typeof b.imageHash !== 'string' || !HASH.test(b.imageHash)) return null;
  const imageUrl = b.imageUrl === undefined || b.imageUrl === null || b.imageUrl === '' ? null : httpsLink(b.imageUrl);
  if (b.imageUrl && !imageUrl) return null;
  return { sourceId: b.sourceId, name, primaryText, headline, description, imageHash: b.imageHash, imageUrl, replace: b.replace === true };
}

/**
 * An A/B variant: a second ad with its own image and text in the ad set of an
 * ad already made from Bodhinox. Meta shares the ad set's budget between the
 * ads and favours the better one. It starts at the creative step.
 */
export async function requestAdVariant(actor: MetaAdsActor, input: AdVariantInput): Promise<AdDraftDto> {
  requireCreator(actor);
  return worker(actor.accountId, async (tx) => {
    const conn = await lockCreatorConnectionTx(tx, actor.accountId);
    const [source] = await tx.$queryRaw<DraftRow[]>`SELECT ${raw(DRAFT_COLUMNS)} FROM meta_ad_drafts
      WHERE account_id=${actor.accountId}::uuid AND id=${input.sourceId}::uuid`;
    if (!source) throw new MetaAdsError('not_found');
    if (source.status !== 'created' || !source.campaign_id || !source.adset_id) throw new MetaAdsError('invalid_choice');
    if (input.replace && !source.ad_id) throw new MetaAdsError('invalid_choice');
    // An unclear create is looked up by name inside the ad set, so a variant never shares the source's name.
    let name = (input.name ?? `${source.name} · B`).slice(0, 200);
    if (name === source.name) name = `${source.name.slice(0, 196)} · B`;
    const [row] = await tx.$queryRaw<DraftRow[]>`
      INSERT INTO meta_ad_drafts(account_id, connection_id, ad_account_id, page_id, kind, name, daily_budget_minor, currency,
        start_time, end_time, countries, age_min, age_max, genders, primary_text, headline, description, link_url, lead_form_id,
        cta_type, image_hash, image_url, whatsapp_number, welcome_message, publish, requested_by, audience_ids, excluded_audience_ids,
        format, video_id, cards, placements, interests, places, locales, variant_of, campaign_id, adset_id, step, bid_cap_minor, replaces_ad_id)
      SELECT account_id, ${conn.id}::uuid, ad_account_id, page_id, kind, ${name}, daily_budget_minor, currency,
        start_time, end_time, countries, age_min, age_max, genders, ${input.primaryText}, ${input.headline}, ${input.description},
        link_url, lead_form_id, cta_type, ${input.imageHash}, ${input.imageUrl}, whatsapp_number, welcome_message, publish,
        ${actor.userId}::uuid, audience_ids, excluded_audience_ids, 'image', NULL, NULL, placements, interests, places, locales,
        id, campaign_id, adset_id, 'creative', bid_cap_minor, ${input.replace ? source.ad_id : null}
      FROM meta_ad_drafts WHERE account_id=${actor.accountId}::uuid AND id=${input.sourceId}::uuid
      RETURNING ${raw(DRAFT_COLUMNS)}`;
    await queueCreateTx(tx, actor.accountId, row.id);
    await audit(tx, actor, input.replace ? 'meta_ads.ad_replace' : 'meta_ads.ad_variant', row.id, { sourceId: input.sourceId });
    return draftDto(row);
  }, actor.userId);
}

// ---------------------------------------------------------------------------
// Facebook Pages (admin)

/** The Facebook Pages the connected login manages (ids and names only, never Page tokens). */
export async function listAdPages(actor: MetaAdsActor): Promise<{ id: string; name: string | null; connected: boolean }[]> {
  requireCreator(actor);
  const conn = await worker(actor.accountId, (tx) => loadActiveConnectionTx(tx, actor.accountId), actor.userId);
  if (!conn?.userToken) throw new MetaAdsError('not_connected');
  try {
    const pages = await listPages(conn.userToken);
    return pages.map((p) => ({ id: p.id, name: p.name, connected: p.id === conn.pageId }));
  } catch (error) {
    console.error('[meta-ads] page list failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
}

/** A Page other than the connected one: one the login manages, and only for kinds that do not need the connected Page. */
async function checkedPage(actor: MetaAdsActor, pageId: string, kind: AdKind): Promise<string | null> {
  const pages = await listAdPages(actor);
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new MetaAdsError('invalid_choice');
  if (page.connected) return null;
  if (CONNECTED_PAGE_KINDS.includes(kind)) throw new MetaAdsError('invalid_choice');
  return page.id;
}

// ---------------------------------------------------------------------------
// Lead form builder (admin)

export function parseLeadFormInput(body: unknown): LeadFormInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const name = text(b.name, 100, 1);
  const questions = Array.isArray(b.questions) ? [...new Set(b.questions)] : [];
  if (!questions.length || !questions.every((q) => (LEAD_QUESTION_TYPES as readonly unknown[]).includes(q))) return null;
  // A lead needs a way back: a phone number or an email.
  if (!questions.includes('PHONE') && !questions.includes('EMAIL')) return null;
  const custom = Array.isArray(b.customQuestions) ? b.customQuestions : [];
  if (custom.length > 5) return null;
  const customQuestions: string[] = [];
  for (const q of custom) {
    const label = text(q, 200, 1);
    if (!label) return null;
    customQuestions.push(label);
  }
  const privacyUrl = httpsLink(b.privacyUrl);
  const privacyText = text(b.privacyText ?? 'Privacy policy', 70, 1);
  const thankYouTitle = text(b.thankYouTitle ?? 'Thanks, we will be in touch', 60, 1);
  const thankYouBody = text(b.thankYouBody ?? 'We will contact you soon.', 160, 1);
  const websiteUrl = b.websiteUrl === undefined || b.websiteUrl === null || b.websiteUrl === '' ? null : httpsLink(b.websiteUrl);
  if (!name || !privacyUrl || !privacyText || !thankYouTitle || !thankYouBody || (b.websiteUrl && !websiteUrl)) return null;
  return { name, questions: questions as LeadQuestionType[], customQuestions, privacyUrl, privacyText, thankYouTitle, thankYouBody, websiteUrl };
}

/**
 * Makes a Meta instant form on the connected Page. Names are unique per Page
 * here: an existing form with the name is refused, and after an unclear
 * outcome the form is looked up by name instead of being made twice.
 */
export async function createPageLeadForm(actor: MetaAdsActor, input: LeadFormInput): Promise<{ id: string; name: string }> {
  requireCreator(actor);
  const conn = await worker(actor.accountId, (tx) => loadActiveConnectionTx(tx, actor.accountId), actor.userId);
  if (!conn?.pageToken || !conn.pageId) throw new MetaAdsError('not_connected');
  if (missingCreateScopes(conn.scopes).length) throw new MetaAdsError('missing_scope');
  const byName = async () => (await listLeadForms(conn.pageId!, conn.pageToken!)).filter((form) => form.name === input.name);
  try {
    if ((await byName()).length) throw new MetaAdsError('name_taken');
    const made = await createLeadForm(conn.pageId, conn.pageToken, input);
    await worker(actor.accountId, (tx) => audit(tx, actor, 'meta_ads.lead_form_create', made.id, { questions: input.questions.length + input.customQuestions.length }), actor.userId);
    return { id: made.id, name: input.name };
  } catch (error) {
    if (error instanceof MetaAdsError) throw error;
    console.error('[meta-ads] lead form create failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    if (!(error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500)) {
      // Unclear: Meta may have made it.
      const found = await byName().catch(() => []);
      if (found.length === 1) return { id: found[0].id, name: input.name };
    }
    throw new MetaAdsError('meta_error');
  }
}
