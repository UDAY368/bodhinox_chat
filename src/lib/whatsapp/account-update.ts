/**
 * Meta's `account_update` webhook field: account-level events for a WhatsApp
 * Business Account (WABA) our app serves. The app must subscribe to the field
 * (Meta App Dashboard → WhatsApp → Configuration → Webhooks; see
 * docs/deployment/railway.md). Reference:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update
 *
 * What each event does to every number of that WABA in the resolved workspace:
 * - remove: PARTNER_REMOVED (the business unshared the WABA from us),
 *   PARTNER_APP_UNINSTALLED for our app, ACCOUNT_DELETED and DISABLED_UPDATE
 *   with ban state DISABLE. Our token no longer works, so the number is
 *   disconnected exactly as an admin disconnect does (disconnectNumber: token
 *   cleared, live flows on it to draft, its campaigns held, default moved,
 *   audited). Every send path already refuses a disconnected number. An admin
 *   reconnects it (Embedded Signup or manually) once the cause is fixed.
 * - warn: ACCOUNT_RESTRICTION, ACCOUNT_VIOLATION, DISABLED_UPDATE with
 *   SCHEDULE_FOR_DISABLE, ACCOUNT_OFFBOARDED. Sends are left to Meta (a
 *   restriction can be partial, e.g. business-initiated only); Settings shows
 *   the event until it expires, a clearing event arrives or the number is
 *   connected again.
 * - clear: DISABLED_UPDATE with REINSTATE, ACCOUNT_RECONNECTED. Recorded, so
 *   the warning disappears.
 * Other events (pricing tiers, verification status, partner added) are ignored.
 *
 * The stored detail is built from Meta enum values only (checked against
 * ^[A-Z_]+$), never free text. An event older than the stored one, or a removal
 * older than the number's current connection, changes nothing, so a replayed or
 * out-of-order delivery cannot disconnect a number that was reconnected since.
 */
import type { PrismaClient } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { disconnectNumber } from './number-admin';

export const ACCOUNT_UPDATE_FIELD = 'account_update';

export type AccountUpdateAction = 'remove' | 'warn' | 'clear';

export interface AccountUpdate {
  wabaId: string;
  event: string;
  action: AccountUpdateAction;
  /** Meta enum values only, comma separated; null when the event has none. */
  detail: string | null;
  /** When the event happened (Meta's entry.time, else now). */
  at: Date;
  /** A restriction's expiry, when Meta gives one. */
  until: Date | null;
}

const META_ID = /^\d{1,32}$/;
const ENUM = /^[A-Z_]{1,64}$/;
const MAX_DETAIL = 300;

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {});
const enumValue = (value: unknown): string | null => (typeof value === 'string' && ENUM.test(value) ? value : null);
const detailOf = (values: Array<string | null>): string | null => {
  const kept = [...new Set(values.filter((v): v is string => v !== null))];
  return kept.length ? kept.join(', ').slice(0, MAX_DETAIL) : null;
};

/** Our Meta app ids, to tell our own uninstall from another partner app's. */
export function ourMetaAppIds(env: Record<string, string | undefined> = process.env): string[] {
  return [env.NEXT_PUBLIC_META_APP_ID, env.META_APP_ID]
    .map((value) => value?.trim() ?? '')
    .filter((value) => META_ID.test(value));
}

/**
 * Parse one account_update change. `entryId` is the webhook entry id: the WABA
 * for most events, our partner business for PARTNER_* events, which name the
 * customer's WABA in value.waba_info.waba_id. Null for an event we ignore or a
 * malformed one.
 */
export function parseAccountUpdate(entryId: unknown, entryTime: unknown, value: unknown, appIds: string[] = ourMetaAppIds()): AccountUpdate | null {
  const v = obj(value);
  const event = enumValue(v.event);
  if (!event) return null;
  const wabaInfo = obj(v.waba_info);
  const wabaCandidate = typeof wabaInfo.waba_id === 'string' && META_ID.test(wabaInfo.waba_id) ? wabaInfo.waba_id : entryId;
  if (typeof wabaCandidate !== 'string' || !META_ID.test(wabaCandidate)) return null;
  const seconds = typeof entryTime === 'number' && Number.isFinite(entryTime) && entryTime > 0 ? entryTime : null;
  const at = seconds ? new Date(seconds * 1000) : new Date();
  const base = { wabaId: wabaCandidate, event, at, until: null as Date | null, detail: null as string | null };

  switch (event) {
    case 'PARTNER_REMOVED': {
      const info = obj(v.disconnection_info);
      return { ...base, action: 'remove', detail: detailOf([enumValue(info.reason), enumValue(info.initiated_by)]) };
    }
    case 'PARTNER_APP_UNINSTALLED': {
      // Another partner app on the same WABA being uninstalled is not about us.
      const appId = typeof wabaInfo.partner_app_id === 'string' ? wabaInfo.partner_app_id : null;
      if (appId && appIds.length > 0 && !appIds.includes(appId)) return null;
      return { ...base, action: 'remove' };
    }
    case 'ACCOUNT_DELETED':
      return { ...base, action: 'remove' };
    case 'DISABLED_UPDATE': {
      const state = enumValue(obj(v.ban_info).waba_ban_state);
      if (state === 'DISABLE') return { ...base, action: 'remove', detail: state };
      if (state === 'SCHEDULE_FOR_DISABLE') return { ...base, action: 'warn', detail: state };
      if (state === 'REINSTATE') return { ...base, action: 'clear', detail: state };
      return null;
    }
    case 'ACCOUNT_RESTRICTION': {
      const items = Array.isArray(v.restriction_info) ? v.restriction_info.slice(0, 16).map(obj) : [];
      const expiries = items
        .map((item) => item.expiration)
        .filter((e): e is number => typeof e === 'number' && Number.isFinite(e) && e > 0);
      const until = expiries.length ? new Date(Math.max(...expiries) * 1000) : null;
      return { ...base, action: 'warn', until, detail: detailOf(items.map((item) => enumValue(item.restriction_type))) };
    }
    case 'ACCOUNT_VIOLATION':
      return { ...base, action: 'warn', detail: detailOf([enumValue(obj(v.violation_info).violation_type)]) };
    case 'ACCOUNT_OFFBOARDED':
      return { ...base, action: 'warn' };
    case 'ACCOUNT_RECONNECTED':
      return { ...base, action: 'clear' };
    default:
      return null;
  }
}

export interface AccountUpdateResult {
  /** Numbers of the WABA in this workspace. */
  matched: number;
  /** Numbers this event disconnected. */
  disconnected: number;
}

/**
 * Apply a parsed event to every number of its WABA in one workspace, in one
 * tenant transaction (worker connection). Locks the workspace's numbers in id
 * order first, the same order disconnectNumber and setDefaultNumber use.
 */
export async function applyAccountUpdate(
  accountId: string,
  update: AccountUpdate,
  db: PrismaClient = getWorkerPrisma()
): Promise<AccountUpdateResult> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; waba_id: string | null; connected_at: Date | null; removed: boolean }[]>`
      SELECT id::text AS id, waba_id, connected_at, (status='disconnected' AND access_token='') AS removed
      FROM whatsapp_config WHERE account_id=${accountId}::uuid ORDER BY id FOR UPDATE`;
    const targets = rows.filter((row) => row.waba_id === update.wabaId);
    let disconnected = 0;
    for (const row of targets) {
      // A removal from before the number's current connection is stale.
      const stale = row.connected_at !== null && row.connected_at.getTime() > update.at.getTime();
      if (update.action === 'remove' && !stale && !row.removed) {
        if (await disconnectNumber(tx, accountId, row.id, null)) disconnected++;
      }
      // Newest event wins; an older delivery never overwrites a newer one.
      await tx.$executeRaw`UPDATE whatsapp_config SET meta_account_event=${update.event},
          meta_account_detail=${update.detail}, meta_account_event_at=${update.at}, meta_account_until=${update.until}
        WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid
          AND (meta_account_event_at IS NULL OR meta_account_event_at <= ${update.at})`;
    }
    if (targets.length > 0) {
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${accountId}::uuid,NULL,'whatsapp_account.meta_update',${update.wabaId},
          ${JSON.stringify({ event: update.event, action: update.action, detail: update.detail, numbers: targets.length, disconnected })}::jsonb)`;
    }
    return { matched: targets.length, disconnected };
  }, db);
}
