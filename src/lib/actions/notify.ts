// "Notify the team" shared by rules (notify_team step) and flows (the Actions step's
// notify_team): an in-app notice to the conversation's assignee or the workspace admins. The
// title is fixed text the author wrote (never the customer's message); the dedupe key makes a
// retried step notify once.
import { notifyAutomationNotice } from '@/lib/notifications/emit';

export type NoticeAudience = 'assignee' | 'admins';

export function noticeAudience(value: unknown): NoticeAudience | null {
  return value === 'assignee' || value === 'admins' ? value : null;
}

export async function notifyTeam(input: {
  accountId: string;
  /** The rule or flow the notice comes from. */
  sourceId: string;
  audience: NoticeAudience;
  title: string;
  conversationId: string | null;
  contactId: string | null;
  dedupeKey: string;
}): Promise<string[]> {
  return notifyAutomationNotice({
    accountId: input.accountId,
    automationId: input.sourceId,
    audience: input.audience,
    title: input.title,
    conversationId: input.conversationId,
    contactId: input.contactId,
    dedupeKey: input.dedupeKey,
  });
}
