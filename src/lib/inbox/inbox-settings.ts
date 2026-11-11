import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { validInstagramText } from '@/lib/instagram/graph-limits';
import {
  AGENT_REPLY_PAUSE_LIMITS, AGENT_VISIBILITY_MODES, AUTO_ASSIGN_MODES, DEFAULT_INBOX_BEHAVIOUR,
  type AgentVisibility, type AutoAssignMode, type InboxBehaviourSettings,
} from '@/types';
import {
  DEFAULT_INBOX_SETTINGS,
  isValidTimeZone,
  parseWorkingHours,
  type InboxSettings,
} from './working-hours';

/**
 * Workspace inbox settings (workspace_inbox_settings): time zone, working
 * hours, away message (with a WhatsApp and an Instagram switch), auto-resolve
 * and first-response SLA, and (Stage 5) how long an agent reply pauses
 * automations, the assignment mode and agent visibility. Every member reads
 * them; admins write them as themselves (RLS admin write). A workspace without
 * a row uses DEFAULT_INBOX_SETTINGS.
 */

export const MAX_AWAY_MESSAGE = 1024;
export const MAX_AUTO_RESOLVE_HOURS = 720;
export const MAX_SLA_MINUTES = 10080;

export type InboxSettingsErrorCode =
  | 'invalid_timezone' | 'invalid_working_hours' | 'invalid_away_message' | 'invalid_auto_resolve' | 'invalid_sla'
  | 'invalid_pause' | 'invalid_assignment' | 'invalid_visibility';

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
export interface WorkspaceInboxSettings extends InboxSettings, InboxBehaviourSettings {
  instagram_away_message_enabled: boolean;
}

// Stage 5 settings and their defaults live in @/types (client-safe); 5D and 5E
// implement what each one does.
export { DEFAULT_INBOX_BEHAVIOUR, type InboxBehaviourSettings };

/**
 * A validated PUT body. The Instagram switch and the Stage 5 settings are
 * optional so older clients that do not send them leave them as they are.
 */
export type InboxSettingsInput = InboxSettings & { instagram_away_message_enabled?: boolean } & Partial<InboxBehaviourSettings>;

type SettingsRow = Omit<WorkspaceInboxSettings, 'working_hours' | 'auto_assign_mode' | 'agent_visibility'>
  & { working_hours: unknown; auto_assign_mode: string; agent_visibility: string };

function toSettings(row: SettingsRow | undefined): WorkspaceInboxSettings {
  if (!row) return { ...DEFAULT_INBOX_SETTINGS, working_hours: {}, instagram_away_message_enabled: false, ...DEFAULT_INBOX_BEHAVIOUR };
  return {
    timezone: row.timezone,
    working_hours: parseWorkingHours(row.working_hours) ?? {},
    away_message_enabled: row.away_message_enabled,
    away_message: row.away_message,
    auto_resolve_after_hours: row.auto_resolve_after_hours,
    sla_first_response_minutes: row.sla_first_response_minutes,
    instagram_away_message_enabled: row.instagram_away_message_enabled === true,
    agent_reply_pause_minutes: row.agent_reply_pause_minutes ?? null,
    auto_assign_mode: (AUTO_ASSIGN_MODES as readonly string[]).includes(row.auto_assign_mode) ? row.auto_assign_mode as AutoAssignMode : 'rules',
    agent_visibility: (AGENT_VISIBILITY_MODES as readonly string[]).includes(row.agent_visibility) ? row.agent_visibility as AgentVisibility : 'all',
  };
}

/** Read the workspace's settings inside an existing tenant transaction (app or worker). */
export async function readInboxSettings(tx: TenantTransaction, accountId: string): Promise<WorkspaceInboxSettings> {
  const rows = await tx.$queryRaw<SettingsRow[]>`SELECT timezone,working_hours,away_message_enabled,away_message,
    auto_resolve_after_hours,sla_first_response_minutes,instagram_away_message_enabled,
    agent_reply_pause_minutes,auto_assign_mode,agent_visibility
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
  // Instagram carries at most 1000 UTF-8 bytes per message, fewer characters than the shared
  // limit in many scripts: a longer text would be skipped on every send, so it is refused here.
  if (instagramAway === true && !validInstagramText(awayMessage)) throw new InboxSettingsError('invalid_away_message');
  const pause = input.agent_reply_pause_minutes;
  if (pause !== undefined && pause !== null && (!Number.isInteger(pause)
    || (pause as number) < AGENT_REPLY_PAUSE_LIMITS.minMinutes || (pause as number) > AGENT_REPLY_PAUSE_LIMITS.maxMinutes))
    throw new InboxSettingsError('invalid_pause');
  const assign = input.auto_assign_mode;
  if (assign !== undefined && !(AUTO_ASSIGN_MODES as readonly unknown[]).includes(assign)) throw new InboxSettingsError('invalid_assignment');
  const visibility = input.agent_visibility;
  if (visibility !== undefined && !(AGENT_VISIBILITY_MODES as readonly unknown[]).includes(visibility)) throw new InboxSettingsError('invalid_visibility');
  return {
    timezone: input.timezone,
    working_hours: workingHours,
    away_message_enabled: awayEnabled,
    away_message: awayMessage || null,
    auto_resolve_after_hours: optionalInt(input.auto_resolve_after_hours, MAX_AUTO_RESOLVE_HOURS, 'invalid_auto_resolve'),
    sla_first_response_minutes: optionalInt(input.sla_first_response_minutes, MAX_SLA_MINUTES, 'invalid_sla'),
    ...(instagramAway === undefined ? {} : { instagram_away_message_enabled: instagramAway }),
    ...(pause === undefined ? {} : { agent_reply_pause_minutes: pause as number | null }),
    ...(assign === undefined ? {} : { auto_assign_mode: assign as AutoAssignMode }),
    ...(visibility === undefined ? {} : { agent_visibility: visibility as AgentVisibility }),
  };
}

/**
 * Replace the settings. An input without the Instagram switch keeps the stored
 * one, except that clearing the away text also turns it off (it has nothing to send).
 * An input without a Stage 5 setting keeps the stored one (a new row gets the default).
 */
export async function saveInboxSettings(tenant: TenantContext, settings: InboxSettingsInput): Promise<WorkspaceInboxSettings> {
  const instagramAway = settings.instagram_away_message_enabled ?? null;
  const pauseGiven = settings.agent_reply_pause_minutes !== undefined;
  const pause = settings.agent_reply_pause_minutes ?? null;
  const assign = settings.auto_assign_mode ?? null;
  const visibility = settings.agent_visibility ?? null;
  return withTenant(tenant, async (tx) => {
    await tx.$executeRaw`INSERT INTO workspace_inbox_settings(account_id,timezone,working_hours,away_message_enabled,away_message,
        auto_resolve_after_hours,sla_first_response_minutes,instagram_away_message_enabled,
        agent_reply_pause_minutes,auto_assign_mode,agent_visibility)
      VALUES(${tenant.accountId}::uuid,${settings.timezone},${JSON.stringify(settings.working_hours)}::jsonb,${settings.away_message_enabled},
        ${settings.away_message},${settings.auto_resolve_after_hours},${settings.sla_first_response_minutes},
        ${settings.away_message !== null && instagramAway === true},
        ${pause}::integer,COALESCE(${assign}::text,'rules'),COALESCE(${visibility}::text,'all'))
      ON CONFLICT(account_id) DO UPDATE SET timezone=EXCLUDED.timezone,working_hours=EXCLUDED.working_hours,
        away_message_enabled=EXCLUDED.away_message_enabled,away_message=EXCLUDED.away_message,
        auto_resolve_after_hours=EXCLUDED.auto_resolve_after_hours,sla_first_response_minutes=EXCLUDED.sla_first_response_minutes,
        instagram_away_message_enabled=CASE WHEN EXCLUDED.away_message IS NULL THEN false
          ELSE COALESCE(${instagramAway}::boolean, workspace_inbox_settings.instagram_away_message_enabled) END,
        agent_reply_pause_minutes=CASE WHEN ${pauseGiven}::boolean THEN EXCLUDED.agent_reply_pause_minutes
          ELSE workspace_inbox_settings.agent_reply_pause_minutes END,
        auto_assign_mode=COALESCE(${assign}::text, workspace_inbox_settings.auto_assign_mode),
        agent_visibility=COALESCE(${visibility}::text, workspace_inbox_settings.agent_visibility)`;
    return readInboxSettings(tx, tenant.accountId);
  });
}
