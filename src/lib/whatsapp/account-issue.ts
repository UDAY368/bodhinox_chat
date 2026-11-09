/**
 * The account problem Meta reported for a number (account_update webhook,
 * src/lib/whatsapp/account-update.ts), as Settings shows it. No imports, so the
 * numbers module can use it without an import cycle.
 */
/** Events Settings shows as a problem on the number. */
export const ACCOUNT_ISSUE_EVENTS = new Set([
  'PARTNER_REMOVED',
  'PARTNER_APP_UNINSTALLED',
  'ACCOUNT_DELETED',
  'DISABLED_UPDATE',
  'ACCOUNT_RESTRICTION',
  'ACCOUNT_VIOLATION',
  'ACCOUNT_OFFBOARDED',
]);

export interface AccountIssue {
  event: string;
  detail: string | null;
  at: string;
  until: string | null;
}

/**
 * The account problem Settings shows for a number, or null: an issue event
 * that has not expired and is not older than the number's current connection.
 */
export function accountIssue(
  row: { meta_account_event: string | null; meta_account_detail: string | null; meta_account_event_at: Date | null; meta_account_until: Date | null; connected_at: Date | null },
  now: Date = new Date()
): AccountIssue | null {
  const { meta_account_event: event, meta_account_event_at: at } = row;
  if (!event || !at || !ACCOUNT_ISSUE_EVENTS.has(event)) return null;
  if (event === 'DISABLED_UPDATE' && row.meta_account_detail === 'REINSTATE') return null;
  if (row.meta_account_until && row.meta_account_until.getTime() <= now.getTime()) return null;
  if (row.connected_at && row.connected_at.getTime() > at.getTime()) return null;
  return { event, detail: row.meta_account_detail, at: at.toISOString(), until: row.meta_account_until?.toISOString() ?? null };
}
