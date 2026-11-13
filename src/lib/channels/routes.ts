// Every channel URL in one place (Stage 1), so the nav, the legacy-URL
// redirects and in-app links agree. Pure: safe in client and server code.
//
// Each channel is its own section: /whatsapp/... and /instagram/... hold the
// inbox, flows and automations. WhatsApp's tools keep their old URLs
// (broadcasts, templates, forms, ads); Instagram's tools live under
// /instagram. /inbox stays the all-channels inbox when both are enabled.
import type { FlowChannelScope } from '@/lib/flows/types';
import type { Channel } from '@/types';

/** Sections every channel has. */
export type ChannelSection = 'inbox' | 'flows' | 'automations' | 'automationNew' | 'automationLogs';
/** WhatsApp-only tools (their URLs predate the channel sections and do not change). */
export type WhatsAppTool = 'broadcasts' | 'templates' | 'forms' | 'ads';
/**
 * Instagram-only tools (Stage 2: comments to quick automations; Stage 3: ref
 * links, menu, insights; Stage 5: the home page, the subscription keywords page
 * and the Basics and Sequences tabs of the automation area).
 */
export type InstagramTool =
  | 'home'
  | 'subscription'
  | 'basics'
  | 'sequences'
  | 'comments'
  | 'conversationStarters'
  | 'defaultReply'
  | 'quickAutomations'
  | 'refLinks'
  | 'menu'
  | 'insights';

/** The all-channels inbox, shown when both channels are enabled. */
export const ALL_INBOXES_PATH = '/inbox';
/** Settings › Channels: the permanent on/off panel. */
export const CHANNELS_SETTINGS_PATH = '/settings?tab=channels';

const WHATSAPP_TOOLS: Record<WhatsAppTool, string> = {
  broadcasts: '/broadcasts',
  // Campaigns > Templates; Settings > Templates still renders the same manager.
  templates: '/templates',
  forms: '/forms',
  ads: '/ads',
};

const INSTAGRAM_TOOLS: Record<InstagramTool, string> = {
  // Stage 5 pages: home and Basics (5F), subscription (5D), sequences (5H).
  home: '/instagram/home',
  subscription: '/instagram/subscription',
  basics: '/instagram/basics',
  sequences: '/instagram/sequences',
  comments: '/instagram/comments',
  conversationStarters: '/instagram/conversation-starters',
  defaultReply: '/instagram/default-reply',
  quickAutomations: '/instagram/quick-automations',
  refLinks: '/instagram/ref-links',
  menu: '/instagram/menu',
  insights: '/instagram/insights',
};

const segment = (id: string): string => {
  if (!id) throw new Error('channelPath needs an id for this section');
  return encodeURIComponent(id);
};

/**
 * The URL of a channel's section or tool. `id` is a conversation id for the
 * inbox (opened with ?c=), a flow id for flows and an automation id for
 * automations (its editor) and automationLogs.
 */
export function channelPath(channel: 'whatsapp', section: ChannelSection | WhatsAppTool, id?: string): string;
export function channelPath(channel: 'instagram', section: ChannelSection | InstagramTool, id?: string): string;
export function channelPath(channel: Channel, section: ChannelSection, id?: string): string;
export function channelPath(channel: Channel, section: ChannelSection | WhatsAppTool | InstagramTool, id?: string): string {
  const base = `/${channel}`;
  switch (section) {
    case 'inbox':
      return id ? `${base}/inbox?c=${encodeURIComponent(id)}` : `${base}/inbox`;
    case 'flows':
      return id ? `${base}/flows/${segment(id)}` : `${base}/flows`;
    case 'automations':
      return id ? `${base}/automations/${segment(id)}/edit` : `${base}/automations`;
    case 'automationNew':
      return `${base}/automations/new`;
    case 'automationLogs':
      return `${base}/automations/${segment(id ?? '')}/logs`;
  }
  const tools: Record<string, string> = channel === 'whatsapp' ? WHATSAPP_TOOLS : INSTAGRAM_TOOLS;
  const path = Object.hasOwn(tools, section) ? tools[section] : undefined;
  if (!path) throw new Error(`${section} is not a ${channel} tool`);
  return path;
}

/** Settings page that connects a channel (numbers or Instagram accounts). */
export function channelSettingsPath(channel: Channel): string {
  return `/settings?tab=${channel}`;
}

/** The channel section a pathname is in, or null outside /whatsapp and /instagram. */
export function channelFromPath(pathname: string): Channel | null {
  const match = /^\/(whatsapp|instagram)(?:\/|$)/.exec(pathname);
  return match ? (match[1] as Channel) : null;
}

/** Where a channel-less link goes: the first enabled channel, WhatsApp first (WhatsApp when none is). */
export function firstEnabledChannel(enabled: readonly Channel[]): Channel {
  return enabled.includes('whatsapp') || !enabled.includes('instagram') ? 'whatsapp' : 'instagram';
}

/**
 * The section a flow opens in from a legacy /flows/[id] link: its own channel,
 * or for a legacy 'any' (or unset) scope WhatsApp unless only Instagram is enabled.
 */
export function sectionForFlowScope(scope: FlowChannelScope | null | undefined, enabled: readonly Channel[]): Channel {
  if (scope === 'whatsapp' || scope === 'instagram') return scope;
  return scope === 'any' ? firstEnabledChannel(enabled) : 'whatsapp';
}
