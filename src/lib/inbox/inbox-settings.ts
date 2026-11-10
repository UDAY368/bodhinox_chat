import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import {
  DEFAULT_INBOX_SETTINGS,
  isValidTimeZone,
  parseWorkingHours,
  type InboxSettings,
} from './working-hours';

/**
 * Workspace inbox settings (workspace_inbox_settings): time zone, working
 * hours, away message (with a WhatsApp and an Instagram switch), auto-resolve
 * and first-response SLA. Every member reads
 * them; admins write them as themselves (RLS admin write). A workspace without
 * a row uses DEFAULT_INBOX_SETTINGS.
 */

export const MAX_AWAY_MESSAGE = 1024;
export const MAX_AUTO_RESOLVE_HOURS = 720;
export const MAX_SLA_MINUTES = 10080;

export type InboxSettingsErrorCode =
  | 'invalid_timezone' | 'invalid_working_hours' | 'invalid_away_message' | 'invalid_auto_resolve' | 'invalid_sla';

export class InboxSettingsError extends Error {
  constructor(readonly code: InboxSettingsErrorCode) {
    super(code);
    this.name = 'InboxSettingsError';
  }
}

/**
 * The stored settings: the shared shape plus the per-channel away switch.
 * away_message_enabled stays the WhatsApp switch; instagram_away_message_enabled
 * (Stage 2, default off) sends the same away text on Instagram.
 */
export interface WorkspaceInboxSettings extends InboxSettings {
  instagram_away_message_enabled: boolean;
}

/**
 * A validated PUT body. The Instagram switch is optional so older clients
 * that do not send it leave it as it is.
 */
export type InboxSettingsInput = InboxSettings & { instagram_away_message_enabled?: boolean };

type SettingsRow = Omit<WorkspaceInboxSettings, 'working_hours'> & { working_hours: unknown };

function toSettings(row: SettingsRow | undefined): WorkspaceInboxSettings {
  if (!row) return { ...DEFAULT_INBOX_SETTINGS, working_hours: {}, instagram_away_message_enabled: false };
  return {
    timezone: row.timezone,
    working_hours: parseWorkingHours(row.working_hours) ?? {},
    away_message_enabled: row.away_message_enabled,
    away_message: row.away_message,
    auto_resolve_after_hours: row.auto_resolve_after_hours,
    sla_first_response_minutes: row.sla_first_response_minutes,
    instagram_away_message_enabled: row.instagram_away_message_enabled === true,
  };
}

/** Read the workspace's settings inside an existing tenant transaction (app or worker). */
export async function readInboxSettings(tx: TenantTransaction, accountId: string): Promise<WorkspaceInboxSettings> {
  const rows = await tx.$queryRaw<SettingsRow[]>`SELECT timezone,working_hours,away_message_enabled,away_message,
    auto_resolve_after_hours,sla_first_response_minutes,instagram_away_message_enabled
    FROM workspace_inbox_settings WHERE account_id=${accountId}::uuid`;
  return toSettings(rows[0]);
}

export async function loadInboxSettings(tenant: TenantContext): Promise<WorkspaceInboxSettings> {
  return withTenant(tenant, (tx) => readInboxSettings(tx, tenant.accountId));
}

function optionalInt(value: unknown, max: number, code: InboxSettingsErrorCode): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new InboxSettingsError(code);
  return value as number;
}

/** Validate a full PUT body. Throws InboxSettingsError naming the bad field. */
export function parseInboxSettingsInput(body: unknown): InboxSettingsInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InboxSettingsError('invalid_timezone');
  const input = body as Record<string, unknown>;
  if (!isValidTimeZone(input.timezone)) throw new InboxSettingsError('invalid_timezone');
  const workingHours = parseWorkingHours(input.working_hours ?? {});
  if (!workingHours) throw new InboxSettingsError('invalid_working_hours');
  if (input.away_message_enabled !== undefined && typeof input.away_message_enabled !== 'boolean')
    throw new InboxSettingsError('invalid_away_message');
  if (input.away_message !== undefined && input.away_message !== null && typeof input.away_message !== 'string')
    throw new InboxSettingsError('invalid_away_message');
  const awayMessage = typeof input.away_message === 'string' ? input.away_message.trim() : '';
  const awayEnabled = input.away_message_enabled === true;
  if (awayMessage.length > MAX_AWAY_MESSAGE || (awayEnabled && !awayMessage)) throw new InboxSettingsError('invalid_away_message');
  const instagramAway = input.instagram_away_message_enabled;
  if (instagramAway !== undefined && typeof instagramAway !== 'boolean') throw new InboxSettingsError('invalid_away_message');
  // The Instagram switch sends the same text, so it needs one too (the table's check agrees).
  if (instagramAway === true && !awayMessage) throw new InboxSettingsError('invalid_away_message');
  return {
    timezone: input.timezone,
    working_hours: workingHours,
    away_message_enabled: awayEnabled,
    away_message: awayMessage || null,
    auto_resolve_after_hours: optionalInt(input.auto_resolve_after_hours, MAX_AUTO_RESOLVE_HOURS, 'invalid_auto_resolve'),
    sla_first_response_minutes: optionalInt(input.sla_first_response_minutes, MAX_SLA_MINUTES, 'invalid_sla'),
    ...(instagramAway === undefined ? {} : { instagram_away_message_enabled: instagramAway }),
  };
}

/**
 * Replace the settings. An input without the Instagram switch keeps the stored
 * one, except that clearing the away text also turns it off (it has nothing to send).
 */
export async function saveInboxSettings(tenant: TenantContext, settings: InboxSettingsInput): Promise<WorkspaceInboxSettings> {
  const instagramAway = settings.instagram_away_message_enabled ?? null;
  return withTenant(tenant, async (tx) => {
    await tx.$executeRaw`INSERT INTO workspace_inbox_settings(account_id,timezone,working_hours,away_message_enabled,away_message,
        auto_resolve_after_hours,sla_first_response_minutes,instagram_away_message_enabled)
      VALUES(${tenant.accountId}::uuid,${settings.timezone},${JSON.stringify(settings.working_hours)}::jsonb,${settings.away_message_enabled},
        ${settings.away_message},${settings.auto_resolve_after_hours},${settings.sla_first_response_minutes},
        ${settings.away_message !== null && instagramAway === true})
      ON CONFLICT(account_id) DO UPDATE SET timezone=EXCLUDED.timezone,working_hours=EXCLUDED.working_hours,
        away_message_enabled=EXCLUDED.away_message_enabled,away_message=EXCLUDED.away_message,
        auto_resolve_after_hours=EXCLUDED.auto_resolve_after_hours,sla_first_response_minutes=EXCLUDED.sla_first_response_minutes,
        instagram_away_message_enabled=CASE WHEN EXCLUDED.away_message IS NULL THEN false
          ELSE COALESCE(${instagramAway}::boolean, workspace_inbox_settings.instagram_away_message_enabled) END`;
    return readInboxSettings(tx, tenant.accountId);
  });
}
