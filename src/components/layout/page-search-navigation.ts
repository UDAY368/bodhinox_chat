// The app's navigation model (Stage 1), shared by the sidebar, the page
// search and the header title so the three always agree. Pure: no React.
//
// Shared business pages sit in the Workspace group, with an "All inboxes"
// entry on top when both channels are enabled; each enabled channel follows
// as its own group (its inbox, flows, automations and tools). Every channel
// link comes from channelPath, so the nav and the redirects agree.
import { ALL_INBOXES_PATH, channelPath } from '@/lib/channels/routes';
import type { WorkspaceChannels } from '@/lib/channels/workspace';
import type { Channel } from '@/types';

export type NavGroupId = 'workspace' | Channel;

export interface NavPage {
  href: string;
  /** Key in the Sidebar namespace (and the Header namespace for page titles). */
  labelKey: string;
  group: NavGroupId;
  /** The unread badge this entry carries: one channel's conversations, or every channel's. */
  unread?: Channel | 'all';
  beta?: boolean;
}

export interface NavGroup {
  id: NavGroupId;
  pages: NavPage[];
}

/** The channels the nav shows. With none known (still loading, or a load failed) the no-row default: WhatsApp. */
export function navChannels(enabled: readonly Channel[] | null | undefined): Channel[] {
  const channels = (['whatsapp', 'instagram'] as const).filter((channel) => enabled?.includes(channel));
  return channels.length ? channels : ['whatsapp'];
}

function channelPages(channel: Channel): NavPage[] {
  const common: NavPage[] = [
    { href: channelPath(channel, 'inbox'), labelKey: 'inbox', group: channel, unread: channel },
    { href: channelPath(channel, 'flows'), labelKey: 'flows', group: channel, beta: true },
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
  // Stage 1 ships the Comments page only; Stage 2 adds conversation starters,
  // default reply and quick automations here once their pages exist.
  return [...common, { href: channelPath('instagram', 'comments'), labelKey: 'comments', group: channel }];
}

function workspacePages(channels: readonly Channel[]): NavPage[] {
  const both = channels.length > 1;
  const page = (href: string, labelKey: string): NavPage => ({ href, labelKey, group: 'workspace' });
  return [
    ...(both ? [{ ...page(ALL_INBOXES_PATH, 'allInboxes'), unread: 'all' as const }] : []),
    page('/dashboard', 'dashboard'),
    page('/analytics', 'analytics'),
    page('/notifications', 'notifications'),
    page('/contacts', 'contacts'),
    page('/pipelines', 'pipelines'),
    page('/appointments', 'appointments'),
    page('/agents', 'aiAgents'),
  ];
}

/** The sidebar's Workspace group, then one group per enabled channel (WhatsApp first). */
export function buildNavigation(enabled: readonly Channel[] | null | undefined): NavGroup[] {
  const channels = navChannels(enabled);
  return [
    { id: 'workspace' as const, pages: workspacePages(channels) },
    ...channels.map((channel) => ({ id: channel, pages: channelPages(channel) })),
  ];
}

/** Pages the search offers besides the groups above (Commerce and Settings). */
const otherSearchPages: NavPage[] = [
  { href: '/commerce/orders', labelKey: 'orders', group: 'workspace' },
  { href: '/commerce/products', labelKey: 'products', group: 'workspace' },
  { href: '/commerce/payments', labelKey: 'payments', group: 'workspace' },
  { href: '/settings', labelKey: 'settings', group: 'workspace' },
];

/** Every page the search lists for a workspace: the same channel filtering as the sidebar. */
export function navigationPages(enabled: readonly Channel[] | null | undefined): NavPage[] {
  return [...buildNavigation(enabled).flatMap((group) => group.pages), ...otherSearchPages];
}

/**
 * Search the workspace's pages by translated label, group label (so
 * "instagram" finds the Instagram pages) and route, ignoring case and
 * surrounding whitespace.
 */
export function filterPages(
  query: string,
  label: (key: string) => string,
  enabled: readonly Channel[] | null | undefined,
  groupLabel: (group: NavGroupId) => string = () => '',
): NavPage[] {
  const search = query.trim().toLocaleLowerCase();
  return navigationPages(enabled).filter((page) =>
    `${groupLabel(page.group)} ${label(page.labelKey)} ${page.href}`.toLocaleLowerCase().includes(search)
  );
}

/**
 * Every page any workspace can have, for titles: a page title never depends
 * on which channels are on. The pre-Stage-1 /flows and /automations URLs keep
 * their titles while they redirect or still render.
 */
const allPages: NavPage[] = [
  ...navigationPages(['whatsapp', 'instagram']).filter((page) => !page.href.includes('?')),
  { href: '/flows', labelKey: 'flows', group: 'workspace' },
  { href: '/automations', labelKey: 'automations', group: 'workspace' },
];

export function getPageTitleKey(pathname: string): string {
  return (
    allPages.find(
      (page) => pathname === page.href || pathname.startsWith(`${page.href}/`)
    )?.labelKey ?? 'dashboard'
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
