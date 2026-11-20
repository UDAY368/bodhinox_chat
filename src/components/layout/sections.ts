// The navigation: the sidebar's sections, each section's pages as tabs above the page, and the
// header breadcrumb. Pure: no React. Every existing page keeps its URL; this only groups them.
import { ALL_INBOXES_PATH, channelPath, type InstagramTool } from '@/lib/channels/routes';
import type { Channel } from '@/types';

export type SectionId =
  | 'home' | 'inbox' | 'contacts' | 'automation' | 'campaigns' | 'ai'
  | 'sales' | 'products' | 'store' | 'analytics' | 'settings';

export interface SectionTab {
  href: string;
  /** Key in the Sidebar namespace. */
  labelKey: string;
  /** Names the channel when a section has one tab per channel ("Rules · Instagram"). */
  channel?: Channel;
}

export interface Section {
  id: SectionId;
  href: string;
  /** Key in the Sidebar namespace. */
  labelKey: string;
  tabs: SectionTab[];
  /** The unread badge: one channel's conversations, or every channel's. */
  unread?: Channel | 'all';
}

/** No section has more tabs than this: more would not fit one row of tabs. */
export const MAX_TABS = 5;

/** The channels the nav shows. With none known (still loading, or a load failed) the no-row default: WhatsApp. */
export function navChannels(enabled: readonly Channel[] | null | undefined): Channel[] {
  const channels = (['whatsapp', 'instagram'] as const).filter((channel) => enabled?.includes(channel));
  return channels.length ? channels : ['whatsapp'];
}

// A tab whose link carries a query never claims a path: otherwise every page under it would count
// as that tab (Templates used to live at /settings?tab=templates; it is /templates now).
const under = (pathname: string, href: string) =>
  !href.includes('?') && (pathname === href || pathname.startsWith(`${href}/`));

/** The sections for a workspace's enabled channels, in sidebar order (Settings last). */
export function buildSections(enabled: readonly Channel[] | null | undefined): Section[] {
  const channels = navChannels(enabled);
  const both = channels.length > 1;
  const sections: Section[] = [
    { id: 'home', href: '/dashboard', labelKey: 'home', tabs: [] },
    both
      ? { id: 'inbox', href: ALL_INBOXES_PATH, labelKey: 'inbox', tabs: [], unread: 'all' }
      : { id: 'inbox', href: channelPath(channels[0], 'inbox'), labelKey: 'inbox', tabs: [], unread: channels[0] },
    {
      id: 'contacts', href: '/contacts', labelKey: 'contacts',
      tabs: [
        { href: '/contacts', labelKey: 'people' },
        { href: '/contacts/segments', labelKey: 'segments' },
        { href: '/contacts/fields', labelKey: 'customFields' },
      ],
    },
    {
      id: 'automation', href: '/automation', labelKey: 'automation',
      // Flows, rules and sequences share one list at /automation (All / Flows / Rules / Sequences);
      // the per-channel rule pages keep their URLs and open from that list.
      tabs: [
        { href: '/automation', labelKey: 'automation' },
        ...(channels.includes('instagram') ? [{ href: channelPath('instagram', 'home'), labelKey: 'instagramTools' }] : []),
      ],
    },
  ];
  if (channels.includes('whatsapp')) {
    sections.push({
      id: 'campaigns', href: channelPath('whatsapp', 'broadcasts'), labelKey: 'campaigns',
      tabs: [
        { href: channelPath('whatsapp', 'broadcasts'), labelKey: 'broadcasts' },
        { href: channelPath('whatsapp', 'templates'), labelKey: 'templates' },
        // The prototype's order: Broadcasts, Templates, Ads, Forms.
        { href: channelPath('whatsapp', 'ads'), labelKey: 'ads' },
        { href: channelPath('whatsapp', 'forms'), labelKey: 'forms' },
      ],
    });
  }
  sections.push(
    { id: 'ai', href: '/agents', labelKey: 'ai', tabs: [] },
    {
      id: 'sales', href: '/pipelines', labelKey: 'sales',
      tabs: [
        { href: '/pipelines', labelKey: 'pipelines' },
        { href: '/appointments', labelKey: 'appointments' },
        { href: '/commerce/orders', labelKey: 'orders' },
        { href: '/commerce/payments', labelKey: 'payments' },
      ],
    },
    {
      id: 'products', href: '/commerce/catalogue', labelKey: 'productsSection',
      tabs: [
        { href: '/commerce/catalogue', labelKey: 'catalogue' },
        { href: '/commerce/products', labelKey: 'whatsappSync' },
      ],
    },
    {
      id: 'store', href: '/commerce/store', labelKey: 'store',
      tabs: [
        { href: '/commerce/store', labelKey: 'onlineStore' },
        { href: '/commerce/reviews', labelKey: 'reviews' },
        { href: '/commerce/settings', labelKey: 'storeSettings' },
        { href: '/commerce/insights', labelKey: 'shopReports' },
      ],
    },
    {
      id: 'analytics', href: '/analytics', labelKey: 'analytics',
      tabs: [
        { href: '/analytics', labelKey: 'analyticsOverview' },
        { href: '/analytics/conversations', labelKey: 'analyticsConversations' },
        { href: '/analytics/team', labelKey: 'analyticsTeam' },
        { href: '/analytics/campaigns', labelKey: 'campaignResults' },
        { href: '/reports', labelKey: 'reports' },
      ],
    },
    { id: 'settings', href: '/settings', labelKey: 'settings', tabs: [] },
  );
  return sections;
}

/** The sidebar's quiet groups (Settings sits apart at the bottom). A null label is the unlabelled top group. */
const SIDEBAR_GROUPS: { labelKey: string | null; ids: SectionId[] }[] = [
  { labelKey: null, ids: ['home', 'inbox', 'contacts'] },
  { labelKey: 'groupGrow', ids: ['automation', 'campaigns', 'ai'] },
  { labelKey: 'groupSell', ids: ['sales', 'products', 'store'] },
  { labelKey: 'groupInsights', ids: ['analytics'] },
];

export function sidebarGroups(sections: readonly Section[]): { labelKey: string | null; sections: Section[] }[] {
  return SIDEBAR_GROUPS
    .map((group) => ({ labelKey: group.labelKey, sections: sections.filter((s) => group.ids.includes(s.id)) }))
    .filter((group) => group.sections.length > 0);
}

/** The section a path belongs to, or null (a page outside every section, such as Notifications). */
export function sectionFor(pathname: string, sections: readonly Section[]): Section | null {
  // Channel inboxes belong to Inbox; every other channel page (flows, rules, Instagram tools) to Automation.
  if (/^\/(whatsapp|instagram)\/inbox(\/|$)/.test(pathname) || under(pathname, ALL_INBOXES_PATH)) {
    return sections.find((s) => s.id === 'inbox') ?? null;
  }
  if (/^\/(flows|automations)(\/|$)/.test(pathname) || /^\/instagram(\/|$)/.test(pathname) || /^\/whatsapp\/(flows|automations)(\/|$)/.test(pathname)) {
    return sections.find((s) => s.id === 'automation') ?? null;
  }
  return sections.find((s) => under(pathname, s.href) || s.tabs.some((tab) => under(pathname, tab.href))) ?? null;
}

/** The tab a path shows, preferring the longest matching tab (so /automation does not win over a channel's rules). */
export function activeTab(pathname: string, section: Section): SectionTab | null {
  const matching = section.tabs.filter((tab) => under(pathname, tab.href));
  if (matching.length) return matching.sort((a, b) => b.href.length - a.href.length)[0];
  // Rules (the old channel-less URLs too), sequences and the Instagram automation rail open from the one Automation list.
  if (/^\/((whatsapp|instagram)\/)?automations(\/|$)/.test(pathname) || /^\/instagram\/(sequences|basics)(\/|$)/.test(pathname)) {
    return section.tabs.find((tab) => tab.href === '/automation') ?? null;
  }
  // Instagram tools other than its home page sit under the Instagram tools tab.
  if (/^\/instagram(\/|$)/.test(pathname) && !/^\/instagram\/(automations|inbox)(\/|$)/.test(pathname)) {
    return section.tabs.find((tab) => tab.labelKey === 'instagramTools') ?? null;
  }
  if (/^\/(flows|whatsapp\/flows|instagram\/flows)(\/|$)/.test(pathname)) return section.tabs.find((tab) => tab.href === '/automation') ?? null;
  return null;
}

/** Pages outside every section, named on their own in the header. */
export const OUTSIDE_PAGES: readonly { href: string; labelKey: string }[] = [
  { href: '/notifications', labelKey: 'notifications' },
];

// Instagram's own pages under Automation: the tool name is also its Sidebar label key.
const INSTAGRAM_PAGES: readonly InstagramTool[] = [
  'comments', 'conversationStarters', 'defaultReply', 'quickAutomations', 'refLinks', 'menu', 'insights',
  'basics', 'sequences', 'subscription',
];

export interface Crumb {
  /** Key in the Sidebar namespace. */
  labelKey: string;
  /** Set on every crumb but the current page. */
  href?: string;
}

/**
 * The header breadcrumb: Section › Tab (Sales › Orders), the tab a link when the page is a record
 * under it (an order). A section without tabs is just the section; a tab named like its section
 * (Automation) is not repeated. Instagram's tools add their own page (Automation › Instagram tools › Comments).
 */
export function breadcrumbFor(pathname: string, sections: readonly Section[]): Crumb[] {
  const section = sectionFor(pathname, sections);
  if (!section) {
    const page = OUTSIDE_PAGES.find((p) => under(pathname, p.href));
    return page ? [{ labelKey: page.labelKey, ...(pathname === page.href ? {} : { href: page.href }) }] : [];
  }
  const crumbs: Crumb[] = [{ labelKey: section.labelKey, href: section.href }];
  const tab = activeTab(pathname, section);
  if (tab && tab.labelKey !== section.labelKey) crumbs.push({ labelKey: tab.labelKey, href: tab.href });
  const tool = INSTAGRAM_PAGES.map((name) => ({ labelKey: name, href: channelPath('instagram', name) }))
    .find((page) => under(pathname, page.href));
  if (section.id === 'automation' && tool && tool.href !== tab?.href) crumbs.push(tool);
  const last = crumbs[crumbs.length - 1];
  // The last crumb is the current page unless the page sits deeper (a record): then it stays a link.
  if (last.href === pathname) delete last.href;
  return crumbs;
}
