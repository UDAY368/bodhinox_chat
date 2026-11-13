import {
  Bell,
  Images,
  Coins,
  CreditCard,
  FileText,
  KeyRound,
  LayoutGrid,
  Inbox,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
  Gauge,
  Megaphone,
  Truck,
  AtSign,
  LockKeyhole,
  Layers,
  Target,
  Building2,
  Plug,
  ScrollText,
} from 'lucide-react';
import type { Channel } from '@/types';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'notifications',
  'appearance',
  'privacy',
  // Settings redesign: name, time zone, default language and working hours.
  'workspace',
  'channels',
  'whatsapp',
  'instagram',
  'members',
  'inbox',
  'media',
  'templates',
  'quick-replies',
  'fields',
  // Stage 5: named conversion events for flows (5F builds the panel).
  'conversion-events',
  'deals',
  'plan',
  // Settings redesign: one card grid for the connected tools.
  'integrations',
  'payments',
  'connections',
  'ads',
  'api',
  'audit-log',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/**
 * Rail grouping: `account` is the signed-in member's own settings (shown as
 * "You"), `workspace` the shared setup, `billing` plan, payments and the
 * connections to other tools (shown as "Account").
 */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace' | 'billing';
  /**
   * Shown inside another section rather than as its own rail entry (the
   * redesign's one Channels and one Integrations section). Its `?tab=` still
   * works and opens the parent with this part selected.
   */
  parent?: SettingsSection;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: {
    id: 'overview',
    label: 'Overview',
    icon: LayoutGrid,
    group: 'top',
  },
  profile: {
    id: 'profile',
    label: 'Your profile',
    icon: User,
    group: 'account',
  },
  security: {
    id: 'security',
    label: 'Login & security',
    icon: Shield,
    group: 'account',
  },
  appearance: {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    group: 'account',
  },
  notifications: {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    group: 'account',
  },
  privacy: { id: 'privacy', label: 'Privacy & access', icon: LockKeyhole, group: 'account' },
  workspace: { id: 'workspace', label: 'Workspace', icon: Building2, group: 'workspace' },
  channels: { id: 'channels', label: 'Channels', icon: Layers, group: 'workspace' },
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: PlugZap,
    group: 'workspace',
    parent: 'channels',
  },
  instagram: { id: 'instagram', label: 'Instagram', icon: AtSign, group: 'workspace', parent: 'channels' },
  inbox: { id: 'inbox', label: 'Inbox', icon: Inbox, group: 'workspace' },
  media: { id: 'media', label: 'Media library', icon: Images, group: 'workspace' },
  templates: {
    id: 'templates',
    label: 'Templates',
    icon: FileText,
    group: 'workspace',
  },
  'quick-replies': {
    id: 'quick-replies',
    label: 'Quick replies',
    icon: Zap,
    group: 'workspace',
  },
  fields: {
    id: 'fields',
    label: 'Fields & tags',
    icon: Tags,
    group: 'workspace',
  },
  'conversion-events': { id: 'conversion-events', label: 'Conversion events', icon: Target, group: 'workspace' },
  deals: {
    id: 'deals',
    label: 'Deals & currency',
    icon: Coins,
    group: 'workspace',
  },
  members: {
    id: 'members',
    label: 'Team members',
    icon: UsersRound,
    group: 'workspace',
  },
  integrations: { id: 'integrations', label: 'Integrations', icon: Plug, group: 'billing' },
  payments: { id: 'payments', label: 'Payments', icon: CreditCard, group: 'billing', parent: 'integrations' },
  connections: { id: 'connections', label: 'Meetings & shipping', icon: Truck, group: 'billing', parent: 'integrations' },
  ads: { id: 'ads', label: 'Ads', icon: Megaphone, group: 'billing' },
  api: { id: 'api', label: 'API & webhooks', icon: KeyRound, group: 'billing' },
  plan: { id: 'plan', label: 'Plan & usage', icon: Gauge, group: 'billing' },
  'audit-log': { id: 'audit-log', label: 'Audit log', icon: ScrollText, group: 'billing' },
};

export const RAIL_GROUPS: {
  label: string | null;
  group: SectionMeta['group'];
}[] = [
  { label: null, group: 'top' },
  { label: 'You', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
  { label: 'Account', group: 'billing' },
];

/** The rail entry that shows a section: its parent, or itself. */
export function railSection(section: SettingsSection): SettingsSection {
  return SECTION_META[section].parent ?? section;
}

/** Sections the rail lists (no parented ones). */
export function isRailSection(section: SettingsSection): boolean {
  return !SECTION_META[section].parent;
}

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}

/**
 * Settings tabs that belong to one channel (Stage 1 channel separation): a
 * channel's connection tab, and WhatsApp's message templates. They are hidden
 * while that channel is not enabled for the workspace; Settings › Channels is
 * where it is turned on.
 */
export const CHANNEL_SECTIONS: Record<Channel, readonly SettingsSection[]> = {
  whatsapp: ['whatsapp', 'templates'],
  instagram: ['instagram'],
};

/**
 * The tabs to hide for the workspace's enabled channels. `null` (channel state
 * not loaded, or failed to load) hides nothing, so the page never loses a tab
 * it showed before Stage 1.
 */
export function hiddenSections(enabled: readonly Channel[] | null): ReadonlySet<SettingsSection> {
  if (!enabled) return new Set();
  return new Set(
    (Object.keys(CHANNEL_SECTIONS) as Channel[])
      .filter((channel) => !enabled.includes(channel))
      .flatMap((channel) => CHANNEL_SECTIONS[channel]),
  );
}

/**
 * The section to render for a `?tab=`: a hidden channel tab (an old link to
 * `?tab=instagram` while Instagram is off) opens Settings › Channels, where the
 * channel can be turned on, instead of a page for a channel the workspace
 * does not use.
 */
export function visibleSection(section: SettingsSection, hidden: ReadonlySet<SettingsSection>): SettingsSection {
  if (!hidden.has(section)) return section;
  // The audit log is hidden from members who may not read it; they land on the Overview.
  return section === 'audit-log' ? DEFAULT_SECTION : 'channels';
}
