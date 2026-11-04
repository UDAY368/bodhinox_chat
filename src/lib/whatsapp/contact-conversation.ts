/**
 * A contact has one conversation per WhatsApp number (and may also have
 * Instagram conversations, which are never picked here). Contact-level work that
 * names no number (scheduled automations, automation steps resumed without a
 * conversation id) acts on the conversation picked here, and never fails
 * because the contact has several.
 */
import type { DataClient } from '@/lib/data/types';
import { loadPickableNumbers, pickDefaultNumber } from './sender-config';

type Db = Pick<DataClient, 'from'>;

/** Thrown when the lookup itself fails; callers map it to their own error. */
export class ContactConversationLookupError extends Error {
  constructor(public readonly cause?: unknown) {
    super('Could not resolve the contact conversation');
    this.name = 'ContactConversationLookupError';
  }
}

/**
 * The contact's conversation on the workspace default number (or an
 * unnumbered legacy one, which replies from the default), else the most
 * recently active. Undefined when the contact has none.
 */
export async function pickContactConversationId(
  db: Db,
  accountId: string,
  contactId: string
): Promise<string | undefined> {
  const found = await db
    .from('conversations')
    .select('id,whatsapp_config_id,channel')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(100);
  if (found.error) throw new ContactConversationLookupError(found.error);
  // WhatsApp conversations only: every caller acts over WhatsApp, and an
  // Instagram row (no number either) must never read as the legacy thread.
  const rows = ((Array.isArray(found.data) ? found.data : found.data ? [found.data] : []) as {
    id: string;
    whatsapp_config_id: string | null;
    channel?: string | null;
  }[]).filter((row) => row.channel == null || row.channel === 'whatsapp');
  if (rows.length <= 1) return rows[0]?.id;
  // Status and the cleared-token check, so a disconnected number is never the fallback.
  const numbers = await loadPickableNumbers(db, accountId);
  if (!numbers) throw new ContactConversationLookupError({ message: 'whatsapp_config lookup failed' });
  const fallback = pickDefaultNumber(numbers);
  return (
    rows.find((row) => fallback && row.whatsapp_config_id === fallback.id) ??
    rows.find((row) => !row.whatsapp_config_id) ??
    rows[0]
  ).id;
}
