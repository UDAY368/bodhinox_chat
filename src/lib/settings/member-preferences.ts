/**
 * A member's own settings for this workspace (member_preferences): their
 * interface language and their notification quiet hours. Reads and writes run
 * as the signed-in member through the app role; RLS limits writes to their own
 * row. A member with no row uses the defaults.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { isAppLocale, type AppLocale } from '@/lib/i18n/locales';
import { DEFAULT_QUIET_HOURS, type QuietHours } from '@/lib/notifications/quiet-hours';

export interface MemberPreferences {
  language: AppLocale | null;
  quiet_hours: QuietHours;
}

type Row = {
  language: string | null;
  quiet_enabled: boolean;
  quiet_start: number;
  quiet_end: number;
  quiet_time_zone: string;
  quiet_allow_mentions: boolean;
};

export function rowToPreferences(row: Row | undefined): MemberPreferences {
  if (!row) return { language: null, quiet_hours: { ...DEFAULT_QUIET_HOURS } };
  return {
    language: isAppLocale(row.language) ? row.language : null,
    quiet_hours: {
      enabled: row.quiet_enabled,
      start: Number(row.quiet_start),
      end: Number(row.quiet_end),
      time_zone: row.quiet_time_zone,
      allow_mentions: row.quiet_allow_mentions,
    },
  };
}

function own(context: TenantContext): TenantContext & { userId: string } {
  if (!context.userId) throw new Error('Member preferences need a member');
  return context as TenantContext & { userId: string };
}

async function read(tx: TenantTransaction, accountId: string, userId: string): Promise<MemberPreferences> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT language, quiet_enabled, quiet_start, quiet_end, quiet_time_zone, quiet_allow_mentions
    FROM member_preferences WHERE account_id=${accountId}::uuid AND user_id=${userId}::uuid`;
  return rowToPreferences(rows[0]);
}

export async function getMemberPreferences(context: TenantContext): Promise<MemberPreferences> {
  const member = own(context);
  return withTenant(member, (tx) => read(tx, member.accountId, member.userId));
}

/** Store the member's language (null clears it, so the workspace default applies). */
export async function saveMemberLanguage(context: TenantContext, language: AppLocale | null): Promise<MemberPreferences> {
  const member = own(context);
  return withTenant(member, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO member_preferences(account_id,user_id,language)
      VALUES(${member.accountId}::uuid,${member.userId}::uuid,${language})
      ON CONFLICT (account_id,user_id) DO UPDATE SET language=EXCLUDED.language`;
    return read(tx, member.accountId, member.userId);
  });
}

/** Store the member's quiet hours inside an open tenant transaction. */
export async function writeQuietHours(tx: TenantTransaction, accountId: string, userId: string, quiet: QuietHours): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO member_preferences(account_id,user_id,quiet_enabled,quiet_start,quiet_end,quiet_time_zone,quiet_allow_mentions)
    VALUES(${accountId}::uuid,${userId}::uuid,${quiet.enabled},${quiet.start},${quiet.end},${quiet.time_zone},${quiet.allow_mentions})
    ON CONFLICT (account_id,user_id) DO UPDATE SET quiet_enabled=EXCLUDED.quiet_enabled, quiet_start=EXCLUDED.quiet_start,
      quiet_end=EXCLUDED.quiet_end, quiet_time_zone=EXCLUDED.quiet_time_zone, quiet_allow_mentions=EXCLUDED.quiet_allow_mentions`;
}

export async function readQuietHours(tx: TenantTransaction, accountId: string, userId: string): Promise<QuietHours> {
  return (await read(tx, accountId, userId)).quiet_hours;
}
