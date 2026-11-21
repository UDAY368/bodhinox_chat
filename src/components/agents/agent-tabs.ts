import { canEditSettings, canSendMessages, type AccountRole } from '@/lib/auth/roles';

/** The AI page's tabs, in order: the agents and what they know, the switches, setup, then the records. */
export const AGENT_TABS = ['agents', 'knowledge', 'features', 'setup', 'activity'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** The sections inside the Activity tab, in order. */
export const ACTIVITY_SECTIONS = ['quality', 'learnings', 'usage', 'log'] as const;
export type ActivitySection = (typeof ACTIVITY_SECTIONS)[number];

/**
 * Old links keep working: /agents?tab=playground opens the agent list (each
 * agent has its test chat); Quality, Learnings and Usage are now sections of
 * the Activity tab.
 */
const LEGACY_TABS: Record<string, AgentTab> = {
  playground: 'agents',
  quality: 'activity',
  learnings: 'activity',
  usage: 'activity',
};

/** The tab a ?tab= value asks for, or null. */
export function requestedTab(value: string | null): AgentTab | null {
  if (!value) return null;
  if ((AGENT_TABS as readonly string[]).includes(value)) return value as AgentTab;
  return LEGACY_TABS[value] ?? null;
}

/** The Activity section an old ?tab=quality|learnings|usage link meant, or null. */
export function requestedActivitySection(value: string | null): ActivitySection | null {
  return value === 'quality' || value === 'learnings' || value === 'usage' ? value : null;
}

/**
 * The Activity sections a role sees. Quality, Usage and the activity log are
 * for admins and owners (Quality and the log hold customer text); Learnings
 * for anyone who can send messages.
 */
export function visibleActivitySections(role: AccountRole | null): ActivitySection[] {
  if (role === null) return [];
  return ACTIVITY_SECTIONS.filter((section) =>
    section === 'learnings' ? canSendMessages(role) : canEditSettings(role));
}

/** The AI tabs a role sees, in order. Assistant features is for admins and owners. */
export function visibleAgentTabs(role: AccountRole | null): AgentTab[] {
  return AGENT_TABS.filter((tab) => {
    if (tab === 'features') return role !== null && canEditSettings(role);
    if (tab === 'activity') return visibleActivitySections(role).length > 0;
    return true;
  });
}
