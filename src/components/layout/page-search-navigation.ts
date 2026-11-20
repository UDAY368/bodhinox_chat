// The page search's list, derived from the sidebar's sections (sections.ts) so the two always
// agree, plus each channel's own pages and the pages outside every section. Pure: no React.
// Every channel link comes from channelPath, so the nav and the redirects agree.
import { channelPath } from '@/lib/channels/routes';
import type { WorkspaceChannels } from '@/lib/channels/workspace';
import type { Channel } from '@/types';
import { buildSections, navChannels, OUTSIDE_PAGES } from './sections';

export { navChannels };

export type NavGroupId = 'workspace' | Channel;

export interface NavPage {
  href: string;
  /** Key in the Sidebar namespace. */
  labelKey: string;
  group: NavGroupId;
  /** The sidebar section the page sits in (Sidebar namespace key), when it is one of its tabs. */
  sectionKey?: string;
  /** The unread badge this entry carries: one channel's conversations, or every channel's. */
  unread?: Channel | 'all';
  beta?: boolean;
}

/** A channel's own pages: its automations and tools. */
function channelPages(channel: Channel): NavPage[] {
  const common: NavPage[] = [
    { href: channelPath(channel, 'automations'), labelKey: 'automations', group: channel },
  ];
  if (channel === 'whatsapp')
    return [
      ...common,
      { href: channelPath('whatsapp', 'broadcasts'), labelKey: 'broadcasts', group: channel },
      { href: channelPath('whatsapp', 'templates'), labelKey: 'templates', group: channel },
      { href: channelPath('whatsapp', 'forms'), labelKey: 'forms', group: channel },
      { href: channelPath('whatsapp', 'ads'), labelKey: 'ads', group: channel },
    ];
  return [
    { href: channelPath('instagram', 'home'), labelKey: 'home', group: channel },
    ...common,
    { href: channelPath('instagram', 'comments'), labelKey: 'comments', group: channel },
    { href: channelPath('instagram', 'conversationStarters'), labelKey: 'conversationStarters', group: channel },
    { href: channelPath('instagram', 'defaultReply'), labelKey: 'defaultReply', group: channel },
    { href: channelPath('instagram', 'quickAutomations'), labelKey: 'quickAutomations', group: channel },
    { href: channelPath('instagram', 'refLinks'), labelKey: 'refLinks', group: channel },
    { href: channelPath('instagram', 'menu'), labelKey: 'menu', group: channel },
    { href: channelPath('instagram', 'insights'), labelKey: 'insights', group: channel },
  ];
}

/**
 * Every page the search lists for a workspace, in sidebar order: each section (or each of its tabs),
 * then each channel's pages not already listed, each channel's inbox when both are on (the sidebar
 * has one Inbox), then the pages outside every section.
 */
export function navigationPages(enabled: readonly Channel[] | null | undefined): NavPage[] {
  const channels = navChannels(enabled);
  const own = channels.flatMap(channelPages);
  // A tab that is a channel's page (Broadcasts, Instagram tools) keeps the channel's name in search.
  const groupOf = (href: string): NavGroupId => own.find((page) => page.href === href)?.group ?? 'workspace';
  const pages: NavPage[] = buildSections(enabled).flatMap((section): NavPage[] =>
    section.tabs.length
      ? section.tabs.map((tab) => ({ href: tab.href, labelKey: tab.labelKey, group: groupOf(tab.href), sectionKey: section.labelKey }))
      : [{ href: section.href, labelKey: section.labelKey, group: 'workspace', ...(section.unread ? { unread: section.unread } : {}) }]
  );
  const channelInboxes: NavPage[] = channels.length > 1
    ? channels.map((channel) => ({ href: channelPath(channel, 'inbox'), labelKey: 'inbox', group: channel }))
    : [];
  return [
    ...pages,
    ...own.filter((page) => !pages.some((listed) => listed.href === page.href)),
    ...channelInboxes,
    ...OUTSIDE_PAGES.map((page) => ({ ...page, group: 'workspace' as const })),
  ];
}

/**
 * Search the workspace's pages by translated label, group label (so
 * "instagram" finds the Instagram pages), section label (so "store" finds
 * Reviews) and route, ignoring case and surrounding whitespace.
 */
export function filterPages(
  query: string,
  label: (key: string) => string,
  enabled: readonly Channel[] | null | undefined,
  groupLabel: (group: NavGroupId) => string = () => '',
): NavPage[] {
  const search = query.trim().toLocaleLowerCase();
  return navigationPages(enabled).filter((page) =>
    [groupLabel(page.group), page.sectionKey && label(page.sectionKey), label(page.labelKey), page.href]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(search)
  );
}

/**
 * The muted "Add Instagram" sidebar link for admins of a WhatsApp-only
 * workspace (it goes to Settings › Channels). Hidden while Instagram is not
 * available on the platform; `upgrade` when the plan is what blocks it.
 */
export function addChannelPrompt(
  data: WorkspaceChannels | null,
  isAdmin: boolean,
): { channel: Channel; upgrade: boolean } | null {
  if (!isAdmin || !data) return null;
  const instagram = data.channels.instagram;
  if (!instagram || instagram.enabled || instagram.unavailableReason === 'platform_off') return null;
  return { channel: 'instagram', upgrade: instagram.unavailableReason === 'plan' };
}
