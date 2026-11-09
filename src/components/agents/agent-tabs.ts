import { canEditSettings, canSendMessages, type AccountRole } from '@/lib/auth/roles';

export const AGENT_TABS = ['setup', 'knowledge', 'learnings', 'playground', 'usage', 'activity'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/**
 * The AI Agents tabs a role sees, in order. Usage and Activity are for
 * admins and owners (Activity holds customer text); Learnings for anyone
 * who can send messages.
 */
export function visibleAgentTabs(role: AccountRole | null): AgentTab[] {
  return AGENT_TABS.filter((tab) => {
    if (tab === 'usage' || tab === 'activity') return role !== null && canEditSettings(role);
    if (tab === 'learnings') return role !== null && canSendMessages(role);
    return true;
  });
}
