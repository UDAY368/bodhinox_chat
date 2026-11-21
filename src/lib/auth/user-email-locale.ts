import { getAuthPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { memberEmailLocales } from '@/lib/i18n/email-locale';
import type { AppLocale } from '@/lib/i18n/locales';

/**
 * The language for an account email to a known person: their own choice in the
 * workspace (`accountId`, else the one their latest session ended in, else their
 * oldest membership — the workspace sign-in returns to), else that workspace's
 * default. Undefined when they have no membership or the lookup fails: the email
 * still goes, in the deployment's language.
 */
export async function userEmailLocale(userId: string, accountId?: string): Promise<AppLocale | undefined> {
  try {
    const home = accountId ?? (await getAuthPrisma().$queryRaw<{ account_id: string }[]>`
      SELECT m.account_id::text AS account_id FROM account_memberships m
      LEFT JOIN LATERAL (SELECT s.account_id FROM auth_sessions s WHERE s.user_id=${userId}::uuid
        ORDER BY s.created_at DESC LIMIT 1) last ON last.account_id=m.account_id
      WHERE m.user_id=${userId}::uuid ORDER BY (last.account_id IS NULL), m.created_at LIMIT 1`)[0]?.account_id;
    if (!home) return undefined;
    const locales = await withTenant({ accountId: home }, (tx) => memberEmailLocales(tx, home, [userId]));
    return locales.get(userId);
  } catch {
    // Never block a password reset or a security notice on the language lookup.
    return undefined;
  }
}
