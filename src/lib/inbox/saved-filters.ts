// Saved inbox views: the shape a member's saved filter holds and the
// validation shared by the API and the inbox. Pure (no I/O) so the client
// bundle can import it; persistence lives in saved-filters-store.ts.

import type { Channel } from '@/types';
import { parseInboxFilter, type InboxFilter } from './inbox-filters';
import type { InboxScope } from './inbox-scope';
import type { SessionFilter } from './session';

/** The inbox conversation list's filter state, as a saved view stores it. */
export interface InboxFilters {
  /** Queue filter (the `?filter=` URL value). */
  filter: InboxFilter;
  /** 24-hour session window filter. */
  session: SessionFilter;
  /** Contact tags, OR-matched. */
  tagIds: string[];
  /** Exact contact company, or null for any. */
  company: string | null;
  /** WhatsApp number id, `'none'` for conversations without one, or null for all. */
  numberId: string | null;
  /** Free-text search over the loaded list. */
  search: string;
  /**
   * The channel the view belongs to: the inbox it was saved in, or the
   * channel filter of the All view. Null for any channel (views saved before
   * the channel inboxes, unless they filter by a WhatsApp number).
   */
  channel: Channel | null;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  filter: 'all',
  session: 'all',
  tagIds: [],
  company: null,
  numberId: null,
  search: '',
  channel: null,
};

export const MAX_SAVED_FILTERS = 50;
export const MAX_SAVED_FILTER_NAME = 80;
export const MAX_SAVED_FILTER_TAGS = 50;
export const MAX_SAVED_FILTER_TEXT = 200;

/** One saved view as the API returns it. */
export interface SavedFilter {
  id: string;
  name: string;
  filters: InboxFilters;
  position: number;
  created_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSIONS: SessionFilter[] = ['all', 'active', 'expired'];

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, MAX_SAVED_FILTER_TEXT) : '';

/**
 * Coerces any stored or submitted value into a valid filter set. Unknown
 * keys are dropped and bad values fall back to the default, so a view saved
 * by an older build (or a tag deleted since) still opens.
 */
export function parseInboxFilters(value: unknown): InboxFilters {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const tagIds = Array.isArray(input.tagIds)
    ? [...new Set(input.tagIds.filter(isUuid).map((id) => id.toLowerCase()))].slice(0, MAX_SAVED_FILTER_TAGS)
    : [];
  const numberId = input.numberId === 'none'
    ? 'none'
    : isUuid(input.numberId)
      ? input.numberId.toLowerCase()
      : null;
  // A number filter only ever matched WhatsApp conversations, so a view
  // without a channel that filters by number is a WhatsApp view.
  const channel: Channel | null = input.channel === 'whatsapp' || input.channel === 'instagram'
    ? input.channel
    : numberId !== null ? 'whatsapp' : null;
  return {
    filter: parseInboxFilter(typeof input.filter === 'string' ? input.filter : null),
    session: SESSIONS.includes(input.session as SessionFilter) ? (input.session as SessionFilter) : 'all',
    tagIds,
    company: text(input.company) || null,
    // Instagram conversations have no number.
    numberId: channel === 'instagram' ? null : numberId,
    search: text(input.search),
    channel,
  };
}

/**
 * The channel a view saved from an inbox of `scope` belongs to: a channel
 * inbox's own channel; in the All view its channel filter, else WhatsApp when
 * it filters by number (the same rule parseInboxFilters reads back).
 */
export function savedViewChannel(scope: InboxScope, channelFilter: Channel | null, numberId: string | null): Channel | null {
  if (scope !== 'all') return scope;
  return channelFilter ?? (numberId !== null ? 'whatsapp' : null);
}

/**
 * A view as an inbox of `scope` applies it: a channel inbox always shows its
 * own channel, so a view for any channel takes the inbox's channel there.
 */
export function filtersInScope(filters: InboxFilters, scope: InboxScope): InboxFilters {
  return scope === 'all' ? filters : { ...filters, channel: scope };
}

/** The views an inbox of `scope` offers: all of them in the All view, else its channel's and any-channel views. */
export function viewsForScope<T extends { filters: InboxFilters }>(views: T[], scope: InboxScope): T[] {
  return scope === 'all' ? views : views.filter((view) => view.filters.channel === null || view.filters.channel === scope);
}

/** A trimmed name of 1..80 characters, or null. */
export function parseSavedFilterName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_SAVED_FILTER_NAME ? name : null;
}

/** True when the filter set narrows nothing. */
export function isDefaultInboxFilters(filters: InboxFilters): boolean {
  return sameInboxFilters(filters, DEFAULT_INBOX_FILTERS);
}

/** Order-insensitive equality on tags; everything else compared directly. */
export function sameInboxFilters(a: InboxFilters, b: InboxFilters): boolean {
  const tags = (ids: string[]) => [...ids].map((id) => id.toLowerCase()).sort().join(',');
  return a.filter === b.filter
    && a.session === b.session
    && tags(a.tagIds) === tags(b.tagIds)
    && (a.company ?? null) === (b.company ?? null)
    && (a.numberId ?? null) === (b.numberId ?? null)
    && a.search.trim() === b.search.trim()
    && (a.channel ?? null) === (b.channel ?? null);
}
