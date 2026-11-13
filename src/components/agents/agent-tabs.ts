import { canEditSettings, canSendMessages, type AccountRole } from '@/lib/auth/roles';

/** The AI page's tabs, in order: the four main sections, then setup and the records. */
export const AGENT_TABS = ['agents', 'knowledge', 'features', 'quality', 'setup', 'learnings', 'usage', 'activity'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** Old links (/agents?tab=playground) open the agent list, where each agent has its test chat. */
const LEGACY_TABS: Record<string, AgentTab> = { playground: 'agents' };

/** The tab a ?tab= value asks for, or null. */
export function requestedTab(value: string | null): AgentTab | null {
  if (!value) return null;
  if ((AGENT_TABS as readonly string[]).includes(value)) return value as AgentTab;
  return LEGACY_TABS[value] ?? null;
}

/**
 * The AI tabs a role sees, in order. Assistant features, Quality, Usage and
 * Activity are for admins and owners (Quality and Activity hold customer
 * text); Learnings for anyone who can send messages.
 */
export function visibleAgentTabs(role: AccountRole | null): AgentTab[] {
  return AGENT_TABS.filter((tab) => {
    if (tab === 'features' || tab === 'quality' || tab === 'usage' || tab === 'activity') return role !== null && canEditSettings(role);
    if (tab === 'learnings') return role !== null && canSendMessages(role);
    return true;
  });
}
