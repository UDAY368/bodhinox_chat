/**
 * Emails to staff in the recipient's own language. Server-only: it loads every
 * locale's catalogue (the browser bundle carries one, via @app-messages).
 *
 * The language is the member's own choice (member_preferences.language), else
 * the workspace default (accounts.default_language), else the deployment
 * default (NEXT_PUBLIC_APP_LOCALE, English when unset) — the same order the
 * interface uses (effectiveLocale).
 */
import { createTranslator } from 'next-intl';
import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';
import pt from '../../../messages/pt.json';
import type { TenantTransaction } from '@/lib/db/tenant';
import { effectiveLocale, type AppLocale } from './locales';
import type { Translate, TranslateValues } from './translate';

const CATALOGUES: Record<AppLocale, Record<string, unknown>> = { en, es, ko, pt };

/** A `t(key, values)` for `namespace` in `locale` (getT, with the locale chosen per recipient). */
export function getLocaleT(locale: AppLocale, namespace: string): Translate {
  const t = createTranslator({
    locale,
    messages: CATALOGUES[locale],
    namespace: namespace as never,
  }) as unknown as (key: string, values?: TranslateValues) => string;
  return (key, values) => t(key, values);
}

/** The email language for a member: their choice, else the workspace's, else the deployment's. */
export function staffEmailLocale(member: string | null | undefined, workspace: string | null | undefined): AppLocale {
  return effectiveLocale(member, workspace);
}

/**
 * The email language of each listed member of one workspace, read inside the
 * caller's tenant transaction (app or worker role). Members without a row get
 * the workspace default. One query, bounded by the list.
 */
export async function memberEmailLocales(tx: TenantTransaction, accountId: string, userIds: readonly string[]): Promise<Map<string, AppLocale>> {
  const rows = await tx.$queryRaw<{ user_id: string; language: string | null; workspace_language: string | null }[]>`
    SELECT m.user_id::text AS user_id, mp.language, a.default_language AS workspace_language
    FROM account_memberships m
    JOIN accounts a ON a.id=m.account_id
    LEFT JOIN member_preferences mp ON mp.account_id=m.account_id AND mp.user_id=m.user_id
    WHERE m.account_id=${accountId}::uuid AND m.user_id = ANY(${[...userIds]}::uuid[])`;
  return new Map(rows.map((row) => [row.user_id, staffEmailLocale(row.language, row.workspace_language)]));
}

/** The workspace's email language (its default, else the deployment's), for mail not addressed to one member. */
export async function workspaceEmailLocale(tx: TenantTransaction, accountId: string): Promise<AppLocale> {
  const rows = await tx.$queryRaw<{ default_language: string | null }[]>`
    SELECT default_language FROM accounts WHERE id=${accountId}::uuid`;
  return staffEmailLocale(null, rows[0]?.default_language);
}
