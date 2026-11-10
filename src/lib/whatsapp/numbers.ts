/**
 * A workspace's WhatsApp numbers (whatsapp_config rows). A workspace can
 * connect several numbers, possibly in different WABAs; exactly one of them is
 * the default (partial unique index whatsapp_config_one_default_per_account,
 * and the first number connected becomes it).
 *
 * Every function here takes a tenant transaction (withTenant), so RLS limits it
 * to that workspace; accountId is also filtered explicitly. Only
 * getConfigForPhoneNumberId runs before a tenant is known, and it uses the same
 * fixed worker routing function as the inbound webhook.
 *
 * A disconnected number keeps its row (status 'disconnected', access_token
 * cleared to ''), so its conversations, campaigns and flows keep pointing at it
 * and nothing is silently re-routed to another number. It never sends, is
 * never the default and is never picked as the "only" number; reconnecting the
 * same phone_number_id revives the row in place (see number-admin.ts). It also
 * stops holding the number: phone_number_id is unique only among rows that are
 * not disconnected, so another workspace may then connect it, and this one
 * cannot reconnect while that one holds it.
 *
 * listNumbers never returns tokens. getNumberConfig returns the full row with
 * the ENCRYPTED access token, for server-side senders only: never return it to
 * a browser and never log it.
 */
import type { whatsapp_config } from '@prisma/client';
import { accountIssue, type AccountIssue } from './account-issue';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { resolveWhatsAppAccount } from '@/lib/repositories/routing';

/** The full stored row. access_token is encrypted at rest; server use only. */
export type NumberConfig = whatsapp_config;

/** A number as settings and pickers may show it: no token or key material. */
export interface WhatsAppNumber {
  id: string;
  phone_number_id: string;
  waba_id: string | null;
  display_name: string | null;
  status: string;
  is_default: boolean;
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  name_status: string | null;
  health_checked_at: Date | null;
  connected_at: Date | null;
  created_at: Date | null;
  /** Disconnected by an admin: kept for history, cannot send until reconnected. */
  removed?: boolean;
  /** A problem Meta reported for this number's WABA (account_update webhook), shown in Settings. */
  account_issue?: AccountIssue | null;
}

/** 'other_channel': the conversation is not on WhatsApp (Phase 11 Instagram). */
export type NoNumberReason = 'none' | 'not_found' | 'no_default' | 'disconnected' | 'other_channel';

/** The workspace has no usable number for this request. */
export class NoNumberError extends Error {
  constructor(public readonly reason: NoNumberReason) {
    super(
      reason === 'not_found'
        ? 'That WhatsApp number is not connected to this workspace'
        : reason === 'disconnected'
          ? 'This WhatsApp number was disconnected. Reconnect it in Settings to send from it.'
          : reason === 'no_default'
          ? 'Choose which WhatsApp number to use'
          : reason === 'other_channel'
          ? 'This conversation is not on WhatsApp'
          : 'WhatsApp not configured. Please set up your WhatsApp integration first.'
    );
    this.name = 'NoNumberError';
  }

  /** next-intl key for a localised message (whatsappNumbers.errors.*). */
  get messageKey(): string {
    const key = {
      none: 'none', not_found: 'notFound', no_default: 'noDefault', disconnected: 'disconnected', other_channel: 'otherChannel',
    }[this.reason];
    return `whatsappNumbers.errors.${key}`;
  }
}

/**
 * Refuse a WhatsApp send, reaction or number lookup for a conversation on
 * another channel. An Instagram conversation has no whatsapp_config_id, which
 * every WhatsApp path would otherwise read as "use the default number" and
 * send to the contact's phone. Callers load `channel` with the conversation
 * and treat NoNumberError as a pre-send "number unavailable" refusal.
 *
 * A send wrapped in dispatchOnce must call this BEFORE dispatchOnce, so no
 * outbound intent is claimed for a conversation that can never be sent on.
 * When the refusal does surface inside dispatchOnce (sender-config's last line
 * of defence), dispatchOnce records the intent as 'failed', not 'unknown',
 * because nothing reached the provider.
 */
export function assertWhatsAppConversation<T extends { channel: string | null | undefined }>(row: T): T {
  if (row.channel != null && row.channel !== 'whatsapp') throw new NoNumberError('other_channel');
  return row;
}

/**
 * True for a number an admin disconnected: status 'disconnected' with its
 * access token cleared. (A number whose Meta registration failed is also
 * 'disconnected' but keeps its token and sends as before.)
 */
export function isNumberDisconnected(row: { status?: string | null; access_token?: string | null }): boolean {
  return row.status === 'disconnected' && row.access_token === '';
}

/** Refuse to send from a disconnected number; never fall back to another one. */
export function assertNumberConnected<T extends { status?: string | null; access_token?: string | null }>(row: T): T {
  if (isNumberDisconnected(row)) throw new NoNumberError('disconnected');
  return row;
}

/** Prisma filter: rows that are not disconnected (default and only-number fallbacks). */
export const usableNumberWhere = { NOT: { status: 'disconnected', access_token: '' } } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const numberSelect = {
  id: true,
  phone_number_id: true,
  waba_id: true,
  display_name: true,
  status: true,
  is_default: true,
  quality_rating: true,
  messaging_limit_tier: true,
  name_status: true,
  health_checked_at: true,
  connected_at: true,
  created_at: true,
} as const;

/** Default first, then oldest first. */
const numberOrder = [{ is_default: 'desc' as const }, { created_at: 'asc' as const }, { id: 'asc' as const }];

/**
 * The workspace's numbers without tokens, default first. Disconnected numbers
 * are listed too (status 'disconnected', removed: true) so callers can tell.
 */
export async function listNumbers(tx: TenantTransaction, accountId: string): Promise<WhatsAppNumber[]> {
  const rows = await tx.whatsapp_config.findMany({ where: { account_id: accountId }, select: numberSelect, orderBy: numberOrder });
  // Disconnected rows are found by filtering on the cleared token, never by reading it.
  const removed = await tx.whatsapp_config.findMany({
    where: { account_id: accountId, status: 'disconnected', access_token: '' },
    select: { id: true },
  });
  const removedIds = new Set(removed.map((row) => row.id));
  // account_update columns are read raw (they carry Meta enum values only, never a token).
  const events = await tx.$queryRaw<AccountEventRow[]>`SELECT id::text AS id, meta_account_event, meta_account_detail,
      meta_account_event_at, meta_account_until FROM whatsapp_config
    WHERE account_id=${accountId}::uuid AND meta_account_event IS NOT NULL`;
  const eventById = new Map((Array.isArray(events) ? events : []).map((row) => [row.id, row]));
  return rows.map((row) => {
    const event = eventById.get(row.id);
    const issue = event ? accountIssue({ ...event, connected_at: row.connected_at }) : null;
    return { ...row, removed: removedIds.has(row.id), account_issue: issue };
  });
}

type AccountEventRow = {
  id: string;
  meta_account_event: string | null;
  meta_account_detail: string | null;
  meta_account_event_at: Date | null;
  meta_account_until: Date | null;
};

/**
 * The number to use: `configId` when given (it must belong to the workspace;
 * there is no silent fallback to another number; the row is returned even when
 * disconnected, with its status, so callers can tell), else the default, else
 * the only connected number. Disconnected numbers are never a fallback.
 * Throws NoNumberError('none' | 'not_found' | 'no_default').
 */
export async function getNumberConfig(
  tx: TenantTransaction,
  accountId: string,
  configId?: string | null
): Promise<NumberConfig> {
  if (configId) {
    if (!UUID.test(configId)) throw new NoNumberError('not_found');
    const row = await tx.whatsapp_config.findFirst({ where: { account_id: accountId, id: configId } });
    if (!row) throw new NoNumberError('not_found');
    return row;
  }
  const rows = await tx.whatsapp_config.findMany({
    where: { account_id: accountId, ...usableNumberWhere },
    orderBy: numberOrder,
    take: 2,
  });
  if (rows.length === 0) throw new NoNumberError('none');
  if (rows[0].is_default || rows.length === 1) return rows[0];
  throw new NoNumberError('no_default');
}

/**
 * The connected number that holds a Meta phone_number_id, with its workspace,
 * or null when no workspace holds it connected. A number only disconnected
 * (possibly in several workspaces) is never returned: at most one connected row
 * can exist (partial unique index whatsapp_config_phone_number_id_connected_key).
 * Resolves the workspace through the worker's fixed routing function (as the
 * inbound webhook does), then reads the row in that tenant's scope.
 */
export async function getConfigForPhoneNumberId(phoneNumberId: string): Promise<NumberConfig | null> {
  const accountId = await resolveWhatsAppAccount(phoneNumberId);
  if (!accountId) return null;
  return withTenant(
    { accountId, role: 'owner' },
    // Disconnected between the two reads: no holder rather than a stale row.
    (tx) => tx.whatsapp_config.findFirst({ where: { account_id: accountId, phone_number_id: phoneNumberId, ...usableNumberWhere } }),
    getWorkerPrisma()
  );
}

/**
 * Make `configId` the workspace default. Locks the workspace's numbers first so
 * concurrent switches serialise instead of colliding on the one-default index.
 * Callers check the admin role; RLS enforces it too. A disconnected number
 * cannot become the default (NoNumberError('disconnected')).
 */
export async function setDefaultNumber(tx: TenantTransaction, accountId: string, configId: string): Promise<void> {
  if (!UUID.test(configId)) throw new NoNumberError('not_found');
  const locked = await tx.$queryRaw<{ id: string; removed: boolean }[]>`SELECT id, (status='disconnected' AND access_token='') AS removed
    FROM whatsapp_config WHERE account_id=${accountId}::uuid ORDER BY id FOR UPDATE`;
  const target = locked.find((row) => row.id === configId);
  if (!target) throw new NoNumberError('not_found');
  if (target.removed) throw new NoNumberError('disconnected');
  await tx.whatsapp_config.updateMany({
    where: { account_id: accountId, is_default: true, NOT: { id: configId } },
    data: { is_default: false },
  });
  await tx.whatsapp_config.updateMany({
    where: { account_id: accountId, id: configId },
    data: { is_default: true },
  });
}
