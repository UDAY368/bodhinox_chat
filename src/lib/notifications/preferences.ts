/**
 * A member's own notification preferences (notification_preferences), one row
 * per event with in-app, email-digest and browser push switches. Reads and writes run as the
 * signed-in member through the app role; RLS limits writes to their own rows.
 * An event with no stored row uses DEFAULT_NOTIFICATION_PREFERENCE.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
} from '@/lib/inbox/notify';

export interface NotificationPreference {
  event: NotificationEvent;
  in_app: boolean;
  email: boolean;
  push: boolean;
}

type StoredPreference = { event: string; in_app: boolean; email: boolean; push?: boolean | null };

export class NotificationPreferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationPreferenceError';
  }
}

/** The email digest needs SMTP and an app origin for links; a boolean only, never the settings. */
export function emailDigestAvailable(): boolean {
  return Boolean(process.env.SMTP_URL && process.env.AUTH_EMAIL_FROM && (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL));
}

/** Every event in NOTIFICATION_EVENTS order, stored values over defaults. */
export function mergePreferences(stored: StoredPreference[]): NotificationPreference[] {
  const byEvent = new Map(stored.map((row) => [row.event, row]));
  return NOTIFICATION_EVENTS.map((event) => {
    const row = byEvent.get(event);
    return {
      event,
      in_app: row ? row.in_app : DEFAULT_NOTIFICATION_PREFERENCE.in_app,
      email: row ? row.email : DEFAULT_NOTIFICATION_PREFERENCE.email,
      push: row?.push ?? DEFAULT_NOTIFICATION_PREFERENCE.push,
    };
  });
}

/**
 * Validate a PUT body: { preferences: [{ event, in_app, email, push? }] }. Each
 * known event at most once; unknown keys or events are rejected rather than
 * ignored. A missing push keeps the stored value (older clients send none).
 */
export function parsePreferenceUpdate(body: unknown): PreferenceUpdate[] {
  const list = (body as { preferences?: unknown } | null)?.preferences;
  if (!Array.isArray(list) || list.length === 0 || list.length > NOTIFICATION_EVENTS.length)
    throw new NotificationPreferenceError('Send a list of notification preferences.');
  const seen = new Set<string>();
  return list.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new NotificationPreferenceError('Each preference must be an object.');
    const { event, in_app, email, push, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) throw new NotificationPreferenceError('Unknown preference field.');
    if (typeof event !== 'string' || !(NOTIFICATION_EVENTS as readonly string[]).includes(event))
      throw new NotificationPreferenceError('Unknown notification event.');
    if (seen.has(event)) throw new NotificationPreferenceError('Each event can appear only once.');
    seen.add(event);
    if (typeof in_app !== 'boolean' || typeof email !== 'boolean')
      throw new NotificationPreferenceError('In-app and email must be true or false.');
    if (push !== undefined && typeof push !== 'boolean')
      throw new NotificationPreferenceError('Push must be true or false.');
    return push === undefined ? { event: event as NotificationEvent, in_app, email } : { event: event as NotificationEvent, in_app, email, push };
  });
}

export type PreferenceUpdate = Omit<NotificationPreference, 'push'> & { push?: boolean };

function own(context: TenantContext): TenantContext & { userId: string } {
  if (!context.userId) throw new Error('Notification preferences need a member');
  return context as TenantContext & { userId: string };
}

export async function getNotificationPreferences(context: TenantContext): Promise<NotificationPreference[]> {
  const member = own(context);
  const rows = await withTenant(member, (tx) => tx.$queryRaw<StoredPreference[]>`
    SELECT event, in_app, email, push FROM notification_preferences
    WHERE account_id=${member.accountId}::uuid AND user_id=${member.userId}::uuid`);
  return mergePreferences(rows);
}

/** Upsert the given events for the signed-in member and return the full set. */
export async function saveNotificationPreferences(
  context: TenantContext,
  updates: PreferenceUpdate[],
  extra?: (tx: TenantTransaction) => Promise<void>,
): Promise<NotificationPreference[]> {
  const member = own(context);
  const rows = await withTenant(member, async (tx) => {
    for (const { event, in_app, email, push } of updates)
      await tx.$executeRaw`
        INSERT INTO notification_preferences(account_id,user_id,event,in_app,email,push)
        VALUES(${member.accountId}::uuid,${member.userId}::uuid,${event},${in_app},${email},COALESCE(${push ?? null}::boolean,false))
        ON CONFLICT (account_id,user_id,event) DO UPDATE SET in_app=EXCLUDED.in_app, email=EXCLUDED.email,
          push=COALESCE(${push ?? null}::boolean, notification_preferences.push)`;
    // Saved in the same transaction (quiet hours), so the section saves all or nothing.
    if (extra) await extra(tx);
    return tx.$queryRaw<StoredPreference[]>`
      SELECT event, in_app, email, push FROM notification_preferences
      WHERE account_id=${member.accountId}::uuid AND user_id=${member.userId}::uuid`;
  });
  return mergePreferences(rows);
}
