// The redesigned navigation: eight sections in the sidebar, each section's pages as tabs above
// the page. Pure: no React. Every existing page keeps its URL; this only groups them.
import { ALL_INBOXES_PATH, channelPath } from '@/lib/channels/routes';
import type { Channel } from '@/types';
import { navChannels } from './page-search-navigation';

export type SectionId = 'inbox' | 'contacts' | 'automation' | 'campaigns' | 'sales' | 'ai' | 'analytics' | 'settings';

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

// A tab whose link carries a query never claims a path: otherwise every page under it would count
// as that tab (Templates used to live at /settings?tab=templates; it is /templates now).
const under = (pathname: string, href: string) =>
  !href.includes('?') && (pathname === href || pathname.startsWith(`${href}/`));

/** The sections for a workspace's enabled channels, in sidebar order (Settings last). */
export function buildSections(enabled: readonly Channel[] | null | undefined): Section[] {
  const channels = navChannels(enabled);
  const both = channels.length > 1;
  const sections: Section[] = [
    both
      ? { id: 'inbox', href: ALL_INBOXES_PATH, labelKey: 'inbox', tabs: [], unread: 'all' }
      : { id: 'inbox', href: channelPath(channels[0], 'inbox'), labelKey: 'inbox', tabs: [], unread: channels[0] },
    { id: 'contacts', href: '/contacts', labelKey: 'contacts', tabs: [] },
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
    {
      id: 'sales', href: '/pipelines', labelKey: 'sales',
      tabs: [
        { href: '/pipelines', labelKey: 'pipelines' },
        { href: '/appointments', labelKey: 'appointments' },
        { href: '/commerce/orders', labelKey: 'orders' },
        { href: '/commerce/catalogue', labelKey: 'catalogue' },
        { href: '/commerce/products', labelKey: 'products' },
        { href: '/commerce/payments', labelKey: 'payments' },
        { href: '/commerce/settings', labelKey: 'storeSettings' },
      ],
    },
    { id: 'ai', href: '/agents', labelKey: 'ai', tabs: [] },
    {
      id: 'analytics', href: '/dashboard', labelKey: 'analytics',
      tabs: [
        { href: '/dashboard', labelKey: 'overview' },
        { href: '/analytics', labelKey: 'analytics' },
        { href: '/reports', labelKey: 'reports' },
      ],
    },
    { id: 'settings', href: '/settings', labelKey: 'settings', tabs: [] },
  );
  return sections;
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
  // Rules, sequences and the Instagram automation rail open from the one Automation list.
  if (/^\/(whatsapp|instagram)\/automations(\/|$)/.test(pathname) || /^\/instagram\/(sequences|basics)(\/|$)/.test(pathname)) {
    return section.tabs.find((tab) => tab.href === '/automation') ?? null;
  }
  // Instagram tools other than its home page sit under the Instagram tools tab.
  if (/^\/instagram(\/|$)/.test(pathname) && !/^\/instagram\/(automations|inbox)(\/|$)/.test(pathname)) {
    return section.tabs.find((tab) => tab.labelKey === 'instagramTools') ?? null;
  }
  if (/^\/(flows|whatsapp\/flows|instagram\/flows)(\/|$)/.test(pathname)) return section.tabs.find((tab) => tab.href === '/automation') ?? null;
  return null;
}
