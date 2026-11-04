/**
 * Notification emit points for inbox, campaign and template events. Each one
 * goes through createNotification, so member preferences (in-app and email
 * digest) and dedupe keys apply the same way everywhere.
 *
 * Titles never carry customer message content: they are written here from
 * fixed text plus names a workspace member chose (campaign, template). The
 * email digest sends titles and links only.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { createNotification, type CreateNotificationResult } from '@/lib/inbox/notify';

/** One "new message" alert per assignee and conversation in this window. */
export const ASSIGNED_MESSAGE_DEBOUNCE_MINUTES = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY: CreateNotificationResult = { inApp: [], emailQueued: [] };

/** Inbox link for a conversation (the inbox opens it from ?c=). */
export const conversationLink = (conversationId: string) => `/inbox?c=${conversationId}`;

/** The dedupe prefix shared by every alert about one conversation. */
export const assignedMessageKeyPrefix = (conversationId: string) => `assigned-message:${conversationId}:`;

/**
 * Tell the conversation's assignee that the customer wrote, at most once per
 * ASSIGNED_MESSAGE_DEBOUNCE_MINUTES. Call it inside the transaction that
 * inserted the inbound message, after the conversation row is locked, so
 * concurrent messages for one conversation are serialised and a rollback
 * drops the alert with the message. The debounce looks at both the in-app row
 * and the email entry, so it also holds for a member with in-app turned off.
 */
export async function notifyAssignedMessage(
  tx: TenantTransaction,
  input: { accountId: string; conversationId: string; contactId: string; messageId: string },
): Promise<CreateNotificationResult> {
  const rows = await tx.$queryRaw<{ assignee: string | null }[]>`
    SELECT assigned_agent_id::text AS assignee FROM conversations
    WHERE account_id=${input.accountId}::uuid AND id=${input.conversationId}::uuid`;
  const assignee = rows[0]?.assignee;
  if (!assignee) return EMPTY;
  const prefix = assignedMessageKeyPrefix(input.conversationId);
  const recent = await tx.$queryRaw<{ recent: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM notifications
        WHERE account_id=${input.accountId}::uuid AND user_id=${assignee}::uuid AND type='assigned_message'
          AND conversation_id=${input.conversationId}::uuid
          AND created_at > now() - make_interval(mins => ${ASSIGNED_MESSAGE_DEBOUNCE_MINUTES}))
      OR EXISTS (SELECT 1 FROM notification_email_queue
        WHERE account_id=${input.accountId}::uuid AND user_id=${assignee}::uuid AND event='assigned_message'
          AND starts_with(dedupe_key, ${prefix})
          AND created_at > now() - make_interval(mins => ${ASSIGNED_MESSAGE_DEBOUNCE_MINUTES}))
    ) AS recent`;
  if (recent[0]?.recent) return EMPTY;
  return createNotification(tx, {
    accountId: input.accountId,
    userIds: [assignee],
    event: 'assigned_message',
    title: 'New message in a conversation assigned to you',
    link: conversationLink(input.conversationId),
    dedupeKey: `${prefix}${input.messageId}`,
    conversationId: input.conversationId,
    contactId: input.contactId,
  });
}

/** Owners and admins of the workspace, for workspace-level alerts. */
async function workspaceAdmins(tx: TenantTransaction, accountId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id::text AS user_id FROM account_memberships
    WHERE account_id=${accountId}::uuid AND role IN ('owner','admin') ORDER BY user_id LIMIT 200`;
  return rows.map((row) => row.user_id);
}

export interface FinishedCampaign {
  id: string;
  account_id: string;
  name?: unknown;
  status?: unknown;
  sent_count?: unknown;
  failed_count?: unknown;
  total_recipients?: unknown;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Stored text for a finished campaign. The name is the member-chosen campaign name. */
export function describeFinishedCampaign(row: FinishedCampaign): { title: string; body: string } {
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 120) : 'Your campaign';
  const failed = row.status === 'failed';
  return {
    title: failed ? `Campaign "${name}" failed` : `Campaign "${name}" finished`,
    body: `${count(row.sent_count)} sent, ${count(row.failed_count)} failed of ${count(row.total_recipients)} recipients.`,
  };
}

/**
 * Alert the campaign's creator (or, if they left the workspace, its owners
 * and admins) that a broadcast finished. Called by the worker once per
 * terminal transition; the dedupe key keeps a replay from alerting twice.
 * Never throws: the campaign status has already committed, and a lost alert
 * must not fail the delivery job.
 */
export async function notifyCampaignFinished(row: FinishedCampaign): Promise<CreateNotificationResult> {
  if (!UUID.test(row.id) || !UUID.test(row.account_id)) return EMPTY;
  try {
    return await withTenant({ accountId: row.account_id, role: 'owner' }, async (tx) => {
      const creator = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT m.user_id::text AS user_id FROM broadcasts b
        JOIN account_memberships m ON m.account_id=b.account_id AND m.user_id=b.user_id
        WHERE b.account_id=${row.account_id}::uuid AND b.id=${row.id}::uuid`;
      const userIds = creator.length ? [creator[0].user_id] : await workspaceAdmins(tx, row.account_id);
      const { title, body } = describeFinishedCampaign(row);
      return createNotification(tx, {
        accountId: row.account_id,
        userIds,
        event: 'campaign_finished',
        title,
        body,
        link: `/broadcasts/${row.id}`,
        dedupeKey: `campaign-finished:${row.id}:${row.status === 'failed' ? 'failed' : 'sent'}`,
      });
    }, getWorkerPrisma());
  } catch {
    console.error('[notifications] campaign finished alert failed', { broadcastId: row.id });
    return EMPTY;
  }
}

/**
 * Alert owners and admins that Meta rejected a template. The dedupe key is
 * bound to the first REJECTED history event of the current rejection, so a
 * replayed webhook or a later quality event adds nothing, while a rejection
 * after a resubmission alerts again. Never throws, like the template webhook.
 */
export async function notifyTemplateRejected(row: {
  id?: unknown;
  account_id?: unknown;
  name?: unknown;
  status?: unknown;
  rejection_reason?: unknown;
}): Promise<CreateNotificationResult> {
  if (row.status !== 'REJECTED' || typeof row.id !== 'string' || typeof row.account_id !== 'string') return EMPTY;
  if (!UUID.test(row.id) || !UUID.test(row.account_id)) return EMPTY;
  const accountId = row.account_id;
  const templateId = row.id;
  try {
    return await withTenant({ accountId, role: 'owner' }, async (tx) => {
      const run = await tx.$queryRaw<{ id: string }[]>`
        SELECT e.id::text AS id FROM template_status_events e
        WHERE e.account_id=${accountId}::uuid AND e.template_id=${templateId}::uuid AND e.status='REJECTED'
          AND e.created_at > COALESCE((SELECT max(o.created_at) FROM template_status_events o
            WHERE o.account_id=${accountId}::uuid AND o.template_id=${templateId}::uuid AND o.status<>'REJECTED'), '-infinity')
        ORDER BY e.created_at, e.id LIMIT 1`;
      const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 120) : 'A message template';
      const reason = typeof row.rejection_reason === 'string' ? row.rejection_reason.trim() : '';
      return createNotification(tx, {
        accountId,
        userIds: await workspaceAdmins(tx, accountId),
        event: 'template_rejected',
        title: `Template "${name}" was rejected`,
        body: reason ? `Meta's reason: ${reason}` : 'Review the template and resubmit it.',
        link: '/settings?tab=templates',
        dedupeKey: `template-rejected:${templateId}:${run[0]?.id ?? 'unrecorded'}`,
      });
    }, getWorkerPrisma());
  } catch {
    console.error('[notifications] template rejected alert failed', { templateId });
    return EMPTY;
  }
}

export type AutomationNoticeAudience = 'assignee' | 'admins';

export interface AutomationNoticeInput {
  accountId: string;
  automationId: string;
  audience: AutomationNoticeAudience;
  /** The notice text, already filled from the automation and contact names only (no message content). */
  title: string;
  conversationId?: string | null;
  contactId?: string | null;
  /** Stable per run and step, so a retried step adds nothing. */
  dedupeKey: string;
}

/**
 * The automation step notify_team: an in-app notice to the conversation's
 * assignee or to the workspace's owners and admins, as type automation_notice.
 * Recipients must be current members. It goes through createNotification,
 * so each member's automation_notice preference decides in-app and email
 * digest, and the dedupe key makes a retried step a no-op. Returns the members
 * notified (in-app or email). Runs on the worker connection.
 */
export async function notifyAutomationNotice(input: AutomationNoticeInput): Promise<string[]> {
  if (!UUID.test(input.accountId) || !UUID.test(input.automationId)) throw new Error('Invalid automation notice');
  const conversationId = input.conversationId && UUID.test(input.conversationId) ? input.conversationId : null;
  const contactId = input.contactId && UUID.test(input.contactId) ? input.contactId : null;
  const title = input.title.trim().slice(0, 200);
  if (!title || !input.dedupeKey || input.dedupeKey.length > 200) throw new Error('Invalid automation notice');
  return withTenant({ accountId: input.accountId, role: 'owner' }, async (tx) => {
    let userIds: string[];
    if (input.audience === 'assignee') {
      if (!conversationId) return [];
      const rows = await tx.$queryRaw<{ assignee: string | null }[]>`
        SELECT assigned_agent_id::text AS assignee FROM conversations
        WHERE account_id=${input.accountId}::uuid AND id=${conversationId}::uuid`;
      userIds = rows[0]?.assignee ? [rows[0].assignee] : [];
    } else {
      userIds = await workspaceAdmins(tx, input.accountId);
    }
    if (!userIds.length) return [];
    const link = conversationId ? conversationLink(conversationId) : `/automations/${input.automationId}/edit`;
    const result = await createNotification(tx, {
      accountId: input.accountId, userIds, event: 'automation_notice', title, link,
      dedupeKey: input.dedupeKey, conversationId, contactId,
    });
    return [...new Set([...result.inApp, ...result.emailQueued])];
  }, getWorkerPrisma());
}
