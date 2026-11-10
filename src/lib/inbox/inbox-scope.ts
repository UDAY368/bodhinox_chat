// Which inbox a page shows (Stage 1 channel separation) and where an inbox
// URL should send the user. Pure, so the inbox client and the server pages
// share one rule set.
//
// /whatsapp/inbox and /instagram/inbox list one channel each; /inbox is the
// All view while both channels are enabled. An old /inbox link (bookmarks,
// notification deep links) goes to the one enabled channel's inbox, and a
// ?c=<id> link to a conversation of another channel goes to that
// conversation's inbox, so every old link still opens its conversation.
import { ALL_INBOXES_PATH, channelPath } from '@/lib/channels/routes';
import type { WorkspaceChannel } from '@/lib/channels/workspace';
import type { Channel, Conversation } from '@/types';

/** The inbox a page shows: one channel, or every channel (the All view). */
export type InboxScope = Channel | 'all';

/** A conversation's channel; rows without one (from before Instagram) are WhatsApp. */
export function channelOfConversation(conversation: Pick<Conversation, 'channel'> | { channel?: string | null } | null | undefined): Channel {
  return conversation?.channel === 'instagram' ? 'instagram' : 'whatsapp';
}

/** Whether a conversation belongs in an inbox of this scope. */
export function inScope(scope: InboxScope, conversation: { channel?: string | null } | null | undefined): boolean {
  return scope === 'all' || channelOfConversation(conversation) === scope;
}

/** The inbox page's own path. */
export function inboxPath(scope: InboxScope): string {
  return scope === 'all' ? ALL_INBOXES_PATH : channelPath(scope, 'inbox');
}

const withSearch = (path: string, search: URLSearchParams) => {
  const query = search.toString();
  return query ? `${path}?${query}` : path;
};

/**
 * Where a conversation opens from outside its channel's inbox: its channel's
 * inbox while that channel is enabled, else the All view (which lists every
 * channel and does not redirect a conversation whose channel is off).
 */
export function conversationInboxPath(channel: Channel, enabled: readonly Channel[], conversationId: string): string {
  return enabled.includes(channel)
    ? channelPath(channel, 'inbox', conversationId)
    : `${ALL_INBOXES_PATH}?c=${encodeURIComponent(conversationId)}`;
}

/**
 * The redirect for an inbox URL, or null to render it. `conversationChannel`
 * is the channel of the ?c= conversation, or null when there is none or it
 * is not in this workspace. Other query values (filter=...) are kept.
 *
 * - /inbox: with exactly one channel enabled, that channel's inbox (a ?c=
 *   conversation on a channel that is off stays in the All view, which lists
 *   it); with both enabled, the All view stays.
 * - /{channel}/inbox?c= of a conversation on the other channel: that
 *   conversation's inbox (see conversationInboxPath).
 */
export function inboxRedirectTarget(input: {
  scope: InboxScope;
  enabled: readonly Channel[];
  conversationChannel: Channel | null;
  search: URLSearchParams;
}): string | null {
  const { scope, enabled, conversationChannel, search } = input;
  if (scope === 'all') {
    if (enabled.length !== 1) return null;
    const only = enabled[0];
    if (conversationChannel && conversationChannel !== only) return null;
    return withSearch(inboxPath(only), search);
  }
  if (!conversationChannel || conversationChannel === scope) return null;
  const target = enabled.includes(conversationChannel) ? inboxPath(conversationChannel) : ALL_INBOXES_PATH;
  return withSearch(target, search);
}

/**
 * The slim channel banners (ChannelStatusBanner) an inbox shows, beside its
 * own detailed ones. Each channel's banners show only in its own inbox:
 * - WhatsApp inbox: "needs attention" unless the "not connected" banner shows
 *   (which already covers a workspace with no connected number).
 * - Instagram inbox: "connect your account" with the routing hint, and "needs
 *   attention" unless a per-account reconnect banner shows.
 * - All view: any channel that needs attention.
 */
export function channelStatusBanners(
  scope: InboxScope,
  channels: Record<Channel, WorkspaceChannel> | undefined,
  shown: { whatsappBannerShown: boolean; instagramBannersShown: boolean },
): WorkspaceChannel[] {
  if (!channels) return [];
  if (scope === 'all') return [channels.whatsapp, channels.instagram].filter((c) => c.state === 'attention');
  const state = channels[scope];
  if (scope === 'whatsapp')
    return state.state === 'attention' && !shown.whatsappBannerShown ? [state] : [];
  if (state.state === 'setup') return [state];
  return state.state === 'attention' && !shown.instagramBannersShown ? [state] : [];
}

/** Next's page searchParams as URLSearchParams (repeated keys kept in order). */
export function toSearchParams(params: Record<string, string | string[] | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) search.append(key, item);
    else if (value !== undefined) search.append(key, value);
  }
  return search;
}
