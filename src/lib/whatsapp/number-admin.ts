/**
 * Admin changes to a workspace's WhatsApp numbers: rename and (soft) disconnect.
 * Every function takes a tenant transaction (withTenant), so RLS limits it to
 * that workspace and to the caller's role; accountId is also filtered
 * explicitly. Nothing here reads or returns token columns.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import type { AccountIssue } from './account-issue';
import { listNumbers, type WhatsAppNumber } from './numbers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DISPLAY_NAME_MAX = 200;

/** A number as the browser receives it: WhatsAppNumber with ISO dates. */
export type WhatsAppNumberDto = Omit<WhatsAppNumber, 'health_checked_at' | 'connected_at' | 'created_at' | 'removed' | 'account_issue'> & {
  /** Disconnected by an admin: listed for history, cannot send until reconnected. */
  removed: boolean;
  /** A problem Meta reported for the number's WABA (Meta enum values only). */
  account_issue?: AccountIssue | null;
  health_checked_at: string | null;
  connected_at: string | null;
  created_at: string | null;
};

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** Copies only the allow-listed fields, so a wider row can never leak a token. */
export function toNumberDto(n: WhatsAppNumber): WhatsAppNumberDto {
  return {
    id: n.id,
    phone_number_id: n.phone_number_id,
    waba_id: n.waba_id,
    display_name: n.display_name,
    status: n.status,
    is_default: n.is_default,
    quality_rating: n.quality_rating,
    messaging_limit_tier: n.messaging_limit_tier,
    name_status: n.name_status,
    health_checked_at: iso(n.health_checked_at),
    connected_at: iso(n.connected_at),
    created_at: iso(n.created_at),
    removed: n.removed ?? false,
    account_issue: n.account_issue ?? null,
  };
}

/** Sets or clears (null / blank) a number's label. False when the number is not this workspace's. */
export async function renameNumber(
  tx: TenantTransaction,
  accountId: string,
  configId: string,
  displayName: string | null
): Promise<boolean> {
  if (!UUID.test(configId)) return false;
  const name = displayName?.trim() ? displayName.trim().slice(0, DISPLAY_NAME_MAX) : null;
  const { count } = await tx.whatsapp_config.updateMany({
    where: { account_id: accountId, id: configId },
    data: { display_name: name },
  });
  return count === 1;
}

export interface DisconnectResult {
  /** The number that became the default, when the removed one was the default. */
  newDefaultId: string | null;
  /** Live flows that triggered only on this number, moved back to draft. */
  pausedFlows: number;
  /**
   * Campaigns still scheduled or sending on this number, and open API
   * campaigns. They are held, not cancelled and not moved: nothing sends
   * from them until this number is reconnected.
   */
  heldCampaigns: { id: string; name: string; status: string }[];
}

/** Why a campaign is held when its number is disconnected (audit metadata). */
export const NUMBER_DISCONNECTED_REASON = 'whatsapp_number_disconnected';

/**
 * Disconnects one number, in the caller's single transaction. The row is never
 * deleted: deleting it would set its conversations, campaigns and flows to "no
 * number", which collides with the one-unnumbered-conversation-per-contact
 * index and silently re-routes them to the default. Instead:
 * - The row becomes status 'disconnected' and its access token is cleared, so
 *   nothing can send from it. Conversations, campaigns and flows keep pointing
 *   at it; every send path refuses a disconnected number rather than falling
 *   back to another one.
 * - Live flows that triggered only on it are moved to draft (drafts untouched).
 * - Campaigns still scheduled or sending on it, and open API campaigns, are
 *   held: their status is unchanged, each is recorded in audit_logs with the
 *   reason, and their sends are refused until the number is reconnected.
 * - When it was the default, the oldest remaining connected number becomes the
 *   default (reported). With none left, the workspace has no default.
 * Reconnecting the same phone_number_id (manual connect or Embedded Signup)
 * updates this row in place and revives it. Running it again on a
 * disconnected number is harmless. Null when the number is not this
 * workspace's.
 */
export async function disconnectNumber(
  tx: TenantTransaction,
  accountId: string,
  configId: string,
  actorUserId: string | null = null
): Promise<DisconnectResult | null> {
  if (!UUID.test(configId)) return null;
  // Lock the workspace's numbers (same order as setDefaultNumber) so a
  // concurrent default switch or disconnect serialises behind this one.
  const locked = await tx.$queryRaw<{ id: string; is_default: boolean }[]>`SELECT id, is_default FROM whatsapp_config
    WHERE account_id=${accountId}::uuid ORDER BY id FOR UPDATE`;
  const target = locked.find((row) => row.id === configId);
  if (!target) return null;

  const paused = await tx.flows.updateMany({
    where: { account_id: accountId, whatsapp_config_id: configId, status: 'active' },
    data: { status: 'draft' },
  });
  const held = await tx.$queryRaw<{ id: string; name: string; status: string }[]>`
    SELECT id::text AS id, name, status FROM broadcasts
    WHERE account_id=${accountId}::uuid AND whatsapp_config_id=${configId}::uuid
      AND (status IN ('scheduled','sending') OR (kind='api' AND status<>'cancelled'))
    ORDER BY created_at, id`;
  for (const campaign of held) {
    // Raw insert: the app role may write audit rows but not read them back.
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${accountId}::uuid,${actorUserId}::uuid,'broadcast.held',${campaign.id},
        ${JSON.stringify({ reason: NUMBER_DISCONNECTED_REASON, whatsapp_config_id: configId, status: campaign.status })}::jsonb)`;
  }

  // Not the default any more first: the one-default index allows one at a time.
  const updated = await tx.whatsapp_config.updateMany({
    where: { account_id: accountId, id: configId },
    data: {
      status: 'disconnected',
      access_token: '',
      is_default: false,
      connected_at: null,
      health_error: null,
      health_error_at: null,
    },
  });
  if (updated.count !== 1) return null;

  let newDefaultId: string | null = null;
  if (target.is_default) {
    // The oldest remaining connected number; one whose registration failed
    // (status 'disconnected' with a token) only when no connected one is left.
    const next = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM whatsapp_config
      WHERE account_id=${accountId}::uuid AND id<>${configId}::uuid AND NOT (status='disconnected' AND access_token='')
      ORDER BY (status='connected') DESC, created_at ASC NULLS LAST, id ASC LIMIT 1`;
    if (next[0]) {
      await tx.whatsapp_config.updateMany({ where: { account_id: accountId, id: next[0].id }, data: { is_default: true } });
      newDefaultId = next[0].id;
    }
  }
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${actorUserId}::uuid,'whatsapp_number.disconnected',${configId},
      ${JSON.stringify({ new_default_id: newDefaultId, paused_flows: paused.count, held_campaigns: held.length })}::jsonb)`;
  return { newDefaultId, pausedFlows: paused.count, heldCampaigns: held };
}

export interface DisconnectReport {
  result: DisconnectResult;
  newDefault: WhatsAppNumber | null;
  /** No connected number is left to be the default. */
  noDefaultLeft: boolean;
}

/** disconnectNumber plus what the caller reports back, in the same transaction. */
export async function disconnectAndReport(
  tx: TenantTransaction,
  accountId: string,
  configId: string,
  actorUserId: string | null
): Promise<DisconnectReport | null> {
  const result = await disconnectNumber(tx, accountId, configId, actorUserId);
  if (!result) return null;
  const numbers = await listNumbers(tx, accountId);
  return {
    result,
    newDefault: result.newDefaultId ? numbers.find((n) => n.id === result.newDefaultId) ?? null : null,
    noDefaultLeft: !numbers.some((n) => n.is_default),
  };
}

/** The response body both disconnect routes answer: what changed, in words too. */
export function disconnectResponse({ result, newDefault, noDefaultLeft }: DisconnectReport) {
  const t = getT('whatsappNumbers');
  const message = [
    t('api.disconnectedSummary'),
    newDefault ? t('api.newDefault', { name: newDefault.display_name?.trim() || newDefault.phone_number_id }) : null,
    noDefaultLeft ? t('api.noDefaultLeft') : null,
    result.pausedFlows > 0 ? t('api.flowsDrafted', { count: result.pausedFlows }) : null,
    result.heldCampaigns.length > 0 ? t('api.campaignsHeld', { count: result.heldCampaigns.length }) : null,
  ].filter(Boolean).join(' ');
  return {
    deleted: false,
    disconnected: true,
    new_default_id: result.newDefaultId,
    new_default: newDefault ? toNumberDto(newDefault) : null,
    no_default_left: noDefaultLeft,
    paused_flows: result.pausedFlows,
    held_campaigns: result.heldCampaigns,
    message,
  };
}
