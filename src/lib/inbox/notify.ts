import { randomUUID } from 'node:crypto';
import type { TenantTransaction } from '@/lib/db/tenant';

/**
 * In-app notifications and email digest entries for inbox events, respecting
 * each member's notification_preferences. Runs inside the caller's tenant
 * transaction (app role as an agent+, or the worker), so the notification
 * commits or rolls back with the change that caused it.
 *
 * Recipients who are not members of the account are dropped. Without a stored
 * preference a member gets in-app notifications and no email. With a dedupe
 * key, a repeated call is a no-op per recipient (unique per account, user and
 * key), for both the in-app row and the email entry.
 *
 * Titles and bodies are stored, never logged.
 */

export const NOTIFICATION_EVENTS = [
  'assigned_message',
  'mention',
  'sla_breach',
  'campaign_finished',
  'template_rejected',
  'number_quality',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** notifications.type for each event; number quality reuses the health alert type. */
export const NOTIFICATION_TYPE_BY_EVENT: Record<NotificationEvent, string> = {
  assigned_message: 'assigned_message',
  mention: 'mention',
  sla_breach: 'sla_breach',
  campaign_finished: 'campaign_finished',
  template_rejected: 'template_rejected',
  number_quality: 'whatsapp_number_health',
};

export const DEFAULT_NOTIFICATION_PREFERENCE = { in_app: true, email: false } as const;
export const MAX_NOTIFICATION_RECIPIENTS = 200;

export interface CreateNotificationInput {
  accountId: string;
  userIds: string[];
  event: NotificationEvent;
  title: string;
  body?: string | null;
  /** In-app path such as "/inbox?c=<id>"; must start with a single "/". */
  link?: string | null;
  dedupeKey?: string | null;
  /** The member who caused it; never notified about their own action. */
  actorUserId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  whatsappConfigId?: string | null;
}

export interface CreateNotificationResult {
  /** Members who got a new in-app notification. */
  inApp: string[];
  /** Members who got a new email digest entry. */
  emailQueued: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK = /^\/[^/\\]/;

function optionalUuid(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  if (!UUID.test(value)) throw new Error(`Invalid notification ${field}`);
  return value;
}

/** Validate a link for notifications.link (relative in-app paths only). */
export function isNotificationLink(link: unknown): link is string {
  return typeof link === 'string' && link.length <= 500 && LINK.test(link);
}

export async function createNotification(
  tx: TenantTransaction,
  input: CreateNotificationInput,
): Promise<CreateNotificationResult> {
  if (!UUID.test(input.accountId)) throw new Error('Invalid notification account');
  if (!(NOTIFICATION_EVENTS as readonly string[]).includes(input.event)) throw new Error('Invalid notification event');
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new Error('Notification title is required');
  const body = input.body?.trim().slice(0, 1000) || null;
  const link = input.link ?? null;
  if (link !== null && !isNotificationLink(link)) throw new Error('Invalid notification link');
  const dedupeKey = input.dedupeKey ?? null;
  if (dedupeKey !== null && (!dedupeKey || dedupeKey.length > 200)) throw new Error('Invalid notification dedupe key');
  const actor = optionalUuid(input.actorUserId, 'actor');
  const conversationId = optionalUuid(input.conversationId, 'conversation');
  const contactId = optionalUuid(input.contactId, 'contact');
  const configId = optionalUuid(input.whatsappConfigId, 'number');

  const userIds = [...new Set(input.userIds)].filter((id) => UUID.test(id) && id !== actor);
  if (userIds.length > MAX_NOTIFICATION_RECIPIENTS) throw new Error('Too many notification recipients');
  const result: CreateNotificationResult = { inApp: [], emailQueued: [] };
  if (!userIds.length) return result;

  const recipients = await tx.$queryRaw<{ user_id: string; in_app: boolean; email: boolean }[]>`
    SELECT m.user_id::text AS user_id,
      COALESCE(p.in_app, ${DEFAULT_NOTIFICATION_PREFERENCE.in_app}) AS in_app,
      COALESCE(p.email, ${DEFAULT_NOTIFICATION_PREFERENCE.email}) AS email
    FROM account_memberships m
    LEFT JOIN notification_preferences p
      ON p.account_id=m.account_id AND p.user_id=m.user_id AND p.event=${input.event}
    WHERE m.account_id=${input.accountId}::uuid AND m.user_id = ANY(${userIds}::uuid[])
    ORDER BY m.user_id`;

  const type = NOTIFICATION_TYPE_BY_EVENT[input.event];
  for (const recipient of recipients) {
    let notificationId: string | null = null;
    if (recipient.in_app) {
      // The id is generated here: the app role cannot read another member's
      // notification back, so RETURNING is not available.
      const id = randomUUID();
      const inserted = await tx.$executeRaw`
        INSERT INTO notifications(id,account_id,user_id,type,conversation_id,contact_id,actor_user_id,
          whatsapp_config_id,title,body,link,dedupe_key)
        VALUES(${id}::uuid,${input.accountId}::uuid,${recipient.user_id}::uuid,${type},${conversationId}::uuid,
          ${contactId}::uuid,${actor}::uuid,${configId}::uuid,${title},${body},${link},${dedupeKey})
        ON CONFLICT DO NOTHING`;
      // Already notified for this dedupe key: the email entry was handled then.
      if (!inserted) continue;
      notificationId = id;
      result.inApp.push(recipient.user_id);
    }
    if (recipient.email) {
      const queued = await tx.$executeRaw`
        INSERT INTO notification_email_queue(account_id,user_id,event,notification_id,title,body,link,dedupe_key)
        VALUES(${input.accountId}::uuid,${recipient.user_id}::uuid,${input.event},${notificationId}::uuid,
          ${title},${body},${link},${dedupeKey})
        ON CONFLICT DO NOTHING`;
      if (queued) result.emailQueued.push(recipient.user_id);
    }
  }
  return result;
}
