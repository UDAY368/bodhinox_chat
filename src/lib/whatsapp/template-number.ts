/**
 * Which WhatsApp number's credentials manage a message template. Templates
 * belong to a WABA (message_templates.waba_id), and a workspace can connect
 * numbers in several WABAs, so template submit/edit/delete/sync pick the
 * number by WABA rather than assuming one config per workspace.
 *
 * Returned rows carry the ENCRYPTED access token: decrypt only to call Meta,
 * never return to a browser and never log.
 */
import type { DataClient } from '@/lib/data/types';
import { NoNumberError } from './numbers';
import { loadSenderConfig, orderNumbers, type SenderConfigRow } from './sender-config';

type Db = Pick<DataClient, 'from'>;

function rowsOf(data: unknown): SenderConfigRow[] {
  return (Array.isArray(data) ? data : data ? [data] : []) as SenderConfigRow[];
}

/**
 * The number that manages a template in `wabaId` (the default number when it
 * is in that WABA, else the oldest one there). Without a WABA (a template
 * from before multi-number, or a new one) it is the workspace default, as
 * before. Throws NoNumberError.
 */
export async function loadTemplateNumberConfig(
  db: Db,
  accountId: string,
  wabaId?: string | null
): Promise<SenderConfigRow> {
  if (!wabaId) return loadSenderConfig(db, accountId);
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('waba_id', wabaId);
  if (error) throw new NoNumberError('none');
  const picked = orderNumbers(rowsOf(data))[0];
  if (!picked) throw new NoNumberError('not_found');
  return picked;
}

/**
 * One number per distinct WABA the workspace has connected, the default
 * number's WABA first. Numbers without a WABA are skipped. Throws
 * NoNumberError('none') when the workspace has no number at all.
 */
export async function listTemplateWabaNumbers(db: Db, accountId: string): Promise<SenderConfigRow[]> {
  const { data, error } = await db.from('whatsapp_config').select('*').eq('account_id', accountId);
  if (error) throw new NoNumberError('none');
  const rows = orderNumbers(rowsOf(data));
  if (rows.length === 0) throw new NoNumberError('none');
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.waba_id || seen.has(row.waba_id)) return false;
    seen.add(row.waba_id);
    return true;
  });
}
