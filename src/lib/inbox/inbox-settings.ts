import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import {
  DEFAULT_INBOX_SETTINGS,
  isValidTimeZone,
  parseWorkingHours,
  type InboxSettings,
} from './working-hours';

/**
 * Workspace inbox settings (workspace_inbox_settings): time zone, working
 * hours, away message, auto-resolve and first-response SLA. Every member reads
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

type SettingsRow = Omit<InboxSettings, 'working_hours'> & { working_hours: unknown };

function toSettings(row: SettingsRow | undefined): InboxSettings {
  if (!row) return { ...DEFAULT_INBOX_SETTINGS, working_hours: {} };
  return {
    timezone: row.timezone,
    working_hours: parseWorkingHours(row.working_hours) ?? {},
    away_message_enabled: row.away_message_enabled,
    away_message: row.away_message,
    auto_resolve_after_hours: row.auto_resolve_after_hours,
    sla_first_response_minutes: row.sla_first_response_minutes,
  };
}

/** Read the workspace's settings inside an existing tenant transaction (app or worker). */
export async function readInboxSettings(tx: TenantTransaction, accountId: string): Promise<InboxSettings> {
  const rows = await tx.$queryRaw<SettingsRow[]>`SELECT timezone,working_hours,away_message_enabled,away_message,
    auto_resolve_after_hours,sla_first_response_minutes FROM workspace_inbox_settings WHERE account_id=${accountId}::uuid`;
  return toSettings(rows[0]);
}

export async function loadInboxSettings(tenant: TenantContext): Promise<InboxSettings> {
  return withTenant(tenant, (tx) => readInboxSettings(tx, tenant.accountId));
}

function optionalInt(value: unknown, max: number, code: InboxSettingsErrorCode): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new InboxSettingsError(code);
  return value as number;
}

/** Validate a full PUT body. Throws InboxSettingsError naming the bad field. */
export function parseInboxSettingsInput(body: unknown): InboxSettings {
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
  return {
    timezone: input.timezone,
    working_hours: workingHours,
    away_message_enabled: awayEnabled,
    away_message: awayMessage || null,
    auto_resolve_after_hours: optionalInt(input.auto_resolve_after_hours, MAX_AUTO_RESOLVE_HOURS, 'invalid_auto_resolve'),
    sla_first_response_minutes: optionalInt(input.sla_first_response_minutes, MAX_SLA_MINUTES, 'invalid_sla'),
  };
}

export async function saveInboxSettings(tenant: TenantContext, settings: InboxSettings): Promise<InboxSettings> {
  return withTenant(tenant, async (tx) => {
    await tx.$executeRaw`INSERT INTO workspace_inbox_settings(account_id,timezone,working_hours,away_message_enabled,away_message,
        auto_resolve_after_hours,sla_first_response_minutes)
      VALUES(${tenant.accountId}::uuid,${settings.timezone},${JSON.stringify(settings.working_hours)}::jsonb,${settings.away_message_enabled},
        ${settings.away_message},${settings.auto_resolve_after_hours},${settings.sla_first_response_minutes})
      ON CONFLICT(account_id) DO UPDATE SET timezone=EXCLUDED.timezone,working_hours=EXCLUDED.working_hours,
        away_message_enabled=EXCLUDED.away_message_enabled,away_message=EXCLUDED.away_message,
        auto_resolve_after_hours=EXCLUDED.auto_resolve_after_hours,sla_first_response_minutes=EXCLUDED.sla_first_response_minutes`;
    return readInboxSettings(tx, tenant.accountId);
  });
}
