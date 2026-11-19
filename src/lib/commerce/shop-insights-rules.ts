/**
 * Pure rules of the shop insights batch (store plan Phase 8, batch 7): the live view's page keys and bucketing, shop search
 * query cleaning, and shop redirect paths with loop detection. No database, no browser: safe to import anywhere.
 */

// ---------------------------------------------------------------------------
// Live view

export const LIVE_WINDOW_MINUTES = 5;
/** Rows older than this are deleted. */
export const LIVE_RETENTION_MINUTES = 120;
/** Hits one workspace can add in one minute; past it a beacon is accepted and not counted. */
export const LIVE_MAX_HITS_PER_MINUTE = 3000;
/** Distinct page keys one workspace can have in one minute; further pages count as "other". */
export const LIVE_MAX_PAGES_PER_MINUTE = 60;
export const LIVE_TOP_PAGES = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PAGE_KEY = /^(home|all|search|cart|links|other|(product|category|page):[0-9a-z-]{1,64})$/;

export const isPageKey = (value: string): boolean => PAGE_KEY.test(value);

/** The minute a time falls in, as an ISO string with seconds cut (the bucket key). */
export function minuteBucket(at: Date): string {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
}

/**
 * The fixed page key of a path under the shop (what the browser reports: "/", "/p/<id>", "/c/<id>", "/pages/<slug>", "/all",
 * "/search", "/cart", "/links"). Anything else, including a malformed id, is "other": the key set cannot be widened by a caller.
 */
export function pageKeyOf(path: unknown): string {
  if (typeof path !== 'string' || path.length > 200) return 'other';
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (clean === '/') return 'home';
  if (clean === '/all' || clean === '/search' || clean === '/cart' || clean === '/links') return clean.slice(1);
  const [, kind, id, ...rest] = clean.split('/');
  if (rest.length || !id) return 'other';
  if (kind === 'p' && UUID.test(id)) return `product:${id.toLowerCase()}`;
  if (kind === 'c' && UUID.test(id)) return `category:${id.toLowerCase()}`;
  if (kind === 'pages' && SLUG.test(id)) return `page:${id}`;
  return 'other';
}

export interface LiveRow { minute: string; page: string; hits: number }
export interface LiveSummary {
  /** Visitors on the shop right now (about): the larger of the last two minutes, since each open tab reports once a minute. */
  active: number;
  /** Hits in each of the last LIVE_WINDOW_MINUTES minutes, oldest first (for a small chart). */
  perMinute: number[];
  /** Pages ordered by hits over the window. */
  pages: Array<{ page: string; hits: number }>;
}

/** The last-five-minutes view of the bucket rows; rows outside the window are ignored. `now` is the server's clock. */
export function summarizeLive(rows: LiveRow[], now: Date): LiveSummary {
  const current = Date.parse(minuteBucket(now));
  const perMinute = Array.from({ length: LIVE_WINDOW_MINUTES }, () => 0);
  const pages = new Map<string, number>();
  for (const row of rows) {
    const age = Math.round((current - Date.parse(row.minute)) / 60_000);
    if (!Number.isFinite(age) || age < 0 || age >= LIVE_WINDOW_MINUTES || !Number.isFinite(row.hits) || row.hits < 0) continue;
    perMinute[LIVE_WINDOW_MINUTES - 1 - age] += row.hits;
    pages.set(row.page, (pages.get(row.page) ?? 0) + row.hits);
  }
  return {
    active: Math.max(perMinute[LIVE_WINDOW_MINUTES - 1], perMinute[LIVE_WINDOW_MINUTES - 2]),
    perMinute,
    pages: [...pages].map(([page, hits]) => ({ page, hits })).sort((a, b) => b.hits - a.hits || a.page.localeCompare(b.page)).slice(0, LIVE_TOP_PAGES),
  };
}

// ---------------------------------------------------------------------------
// Search

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 60;
export const SEARCH_MAX_TERMS = 4;
export const SEARCH_SUGGESTIONS = 8;
export const SEARCH_RESULTS = 24;

/** The words of a typed query: control characters dropped, spaces collapsed, at most 4 words and 60 characters; [] when too short. */
export function searchTerms(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  const text = input.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_LENGTH);
  if (text.length < SEARCH_MIN_LENGTH) return [];
  return text.split(' ').filter(Boolean).slice(0, SEARCH_MAX_TERMS);
}

/** An ILIKE pattern for one word: the LIKE wildcards in it are escaped (the query uses ESCAPE '\'). */
export const likeContains = (term: string): string => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const likePrefix = (term: string): string => `${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---------------------------------------------------------------------------
// Redirects

export const REDIRECT_LIMIT = 200;
export const REDIRECT_MAX_HOPS = 5;
export const REDIRECT_CODES = [301, 302] as const;
export type RedirectCode = (typeof REDIRECT_CODES)[number];

const PATH_BODY = /^\/[A-Za-z0-9._~%/-]{0,199}$/;

export interface RedirectRule { from: string; to: string; code: RedirectCode }
export type RedirectIssue = 'invalid_from' | 'invalid_to' | 'same' | 'loop' | 'duplicate' | 'limit';

/**
 * A path inside one shop, relative to /s/<handle> ("/old-oil", "/p/<id>"). Accepts the path with or without the "/s/<handle>" prefix.
 * Anything with a scheme, a host, "//", "..", a query or a fragment is refused, so a redirect can only land inside the same shop.
 * A trailing slash is dropped; the shop home is "/". Null when invalid.
 */
export function cleanShopPath(input: unknown, handle: string): string | null {
  if (typeof input !== 'string') return null;
  let path = input.trim();
  if (!path || path.length > 220) return null;
  const prefix = `/s/${handle}`;
  if (path === prefix || path.startsWith(`${prefix}/`)) path = path.slice(prefix.length) || '/';
  if (!path.startsWith('/') || path.includes('\\')) return null;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (!PATH_BODY.test(path) || path.includes('//') || path.includes('..')) return null;
  return path;
}

/** The rule's destination followed through the other rules: the final path, or null when it loops or runs past REDIRECT_MAX_HOPS. */
export function resolveRedirectChain(rules: readonly RedirectRule[], from: string): { to: string; code: RedirectCode } | null {
  const byFrom = new Map(rules.map((r) => [r.from, r]));
  const first = byFrom.get(from);
  if (!first) return null;
  const seen = new Set([from]);
  let current = first;
  let permanent = first.code === 301;
  for (let hop = 0; hop < REDIRECT_MAX_HOPS; hop++) {
    const next = byFrom.get(current.to);
    if (!next) return { to: current.to, code: permanent ? 301 : 302 };
    if (seen.has(next.from)) return null;
    seen.add(next.from);
    permanent = permanent && next.code === 301;
    current = next;
  }
  return null;
}

/** Why `rule` cannot be added to `existing`, or null. Follows its destination through the existing rules; a chain back to its own source is a loop. */
export function redirectIssue(rule: RedirectRule, existing: readonly RedirectRule[]): RedirectIssue | null {
  if (rule.from === '/' ) return 'invalid_from';
  if (rule.from === rule.to) return 'same';
  if (existing.some((r) => r.from === rule.from)) return 'duplicate';
  if (existing.length >= REDIRECT_LIMIT) return 'limit';
  const all = [...existing, rule];
  // Every source reachable through the new rule must still end somewhere.
  for (const r of all) if (!resolveRedirectChain(all, r.from)) return 'loop';
  return null;
}
