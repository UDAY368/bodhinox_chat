/**
 * Which WhatsApp number a send goes out from, for the send paths that use the
 * query-builder DataClient (numbers.ts has the Prisma-transaction twin).
 *
 * - Replies, flow/automation steps and AI replies: the conversation's number
 *   (conversations.whatsapp_config_id), else the workspace default.
 * - Broadcasts and API campaigns: broadcasts.whatsapp_config_id, else default.
 * - Templates belong to a WABA: a template stamped with another WABA than the
 *   sending number's is refused (TemplateNumberMismatchError).
 *
 * The returned row carries the ENCRYPTED access token: decrypt it only to call
 * Meta, never return it to a browser and never log it.
 */
import activeMessages from '@app-messages';
import type { DataClient, Row } from '@/lib/data/types';
import { getT, type TranslateValues } from '@/lib/i18n/translate';
import { assertNumberConnected, assertWhatsAppConversation, isNumberDisconnected, NoNumberError } from './numbers';

type Db = Pick<DataClient, 'from'>;

/** A whatsapp_config row as stored; access_token is encrypted. Server use only. */
export type SenderConfigRow = Row & {
  id: string;
  phone_number_id: string;
  access_token: string;
  waba_id?: string | null;
  is_default?: boolean | null;
  created_at?: string | Date | null;
  user_id?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default first, then oldest first (same order as numbers.ts listNumbers). */
export function orderNumbers<T extends { id?: unknown; is_default?: boolean | null; created_at?: unknown }>(rows: T[]): T[] {
  const time = (value: unknown) => (value ? new Date(value as string).getTime() : 0);
  return rows.slice().sort((a, b) =>
    Number(!!b.is_default) - Number(!!a.is_default) ||
    time(a.created_at) - time(b.created_at) ||
    String(a.id ?? '').localeCompare(String(b.id ?? '')));
}

type Pickable = { id?: unknown; is_default?: boolean | null; created_at?: unknown };

/** A disconnected number, told by `removed` (listNumbers) or by its status and cleared token. */
function isRemoved(row: object): boolean {
  const r = row as { removed?: unknown; status?: string | null; access_token?: string | null };
  return r.removed === true || isNumberDisconnected(r);
}

/**
 * The default number of `rows`, else the only one, else null (none, or several
 * with no default). Disconnected numbers are ignored, so they are never picked
 * and never make a lone connected number ambiguous. Callers whose rows carry
 * neither `removed` nor status/access_token cannot tell; select them.
 */
export function pickDefaultNumber<T extends Pickable>(rows: T[]): T | null {
  const ordered = orderNumbers(rows.filter((row) => !isRemoved(row)));
  if (ordered.length === 1 || ordered[0]?.is_default) return ordered[0];
  return null;
}

/** A number as pickDefaultNumber needs it, without its token. */
export type PickableNumberRow = {
  id: string;
  is_default: boolean | null;
  created_at: string | null;
  status: string | null;
  removed: boolean;
};

/**
 * The workspace's numbers for pickDefaultNumber, with `removed` set on the
 * disconnected ones. Never reads a token: disconnected rows are found by
 * filtering on the cleared token (as numbers.ts listNumbers does). Null when a
 * lookup fails, so callers can refuse instead of guessing.
 */
export async function loadPickableNumbers(db: Db, accountId: string): Promise<PickableNumberRow[] | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('id,is_default,created_at,status')
    .eq('account_id', accountId);
  if (error) return null;
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as Omit<PickableNumberRow, 'removed'>[];
  if (!rows.some((row) => row.status === 'disconnected')) return rows.map((row) => ({ ...row, removed: false }));
  const removed = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('status', 'disconnected')
    .eq('access_token', '');
  if (removed.error) return null;
  const removedRows = (Array.isArray(removed.data) ? removed.data : removed.data ? [removed.data] : []) as { id: string }[];
  const removedIds = new Set(removedRows.map((row) => row.id));
  return rows.map((row) => ({ ...row, removed: removedIds.has(row.id) }));
}

/**
 * The number to send from: `configId` when given (it must belong to the
 * workspace; no silent fallback), else the default, else the only connected
 * number. Throws NoNumberError: 'disconnected' for a named number an admin
 * disconnected (never a fallback to another one), 'none' when the workspace
 * has no connected number at all. A lookup error reads as 'none', as the
 * single-number code did before.
 */
export async function loadSenderConfig(
  db: Db,
  accountId: string,
  configId?: string | null
): Promise<SenderConfigRow> {
  if (configId) {
    if (!UUID.test(configId)) throw new NoNumberError('not_found');
    const { data, error } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', configId)
      .maybeSingle();
    if (error) throw new NoNumberError('none');
    if (!data) throw new NoNumberError('not_found');
    return assertNumberConnected(data as SenderConfigRow);
  }
  const { data, error } = await db.from('whatsapp_config').select('*').eq('account_id', accountId);
  if (error) throw new NoNumberError('none');
  const all = (Array.isArray(data) ? data : data ? [data] : []) as SenderConfigRow[];
  // Every number disconnected reads as "not configured", not "choose a number".
  const rows = all.filter((row) => !isNumberDisconnected(row));
  if (rows.length === 0) throw new NoNumberError('none');
  const picked = pickDefaultNumber(rows);
  if (!picked) throw new NoNumberError('no_default');
  return picked;
}

/** The number a Meta phone_number_id names in this workspace (public API `phone_number_id`). */
export async function loadSenderConfigByPhoneNumberId(
  db: Db,
  accountId: string,
  phoneNumberId: string
): Promise<SenderConfigRow> {
  if (!/^\d{1,32}$/.test(phoneNumberId)) throw new NoNumberError('not_found');
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();
  if (error) throw new NoNumberError('none');
  if (!data) throw new NoNumberError('not_found');
  return assertNumberConnected(data as SenderConfigRow);
}

/**
 * The number a conversation replies from: its whatsapp_config_id, or the
 * workspace default for a legacy conversation with none. A conversation on
 * another channel (Instagram) is refused with NoNumberError('other_channel'),
 * never answered from the default number. This is a last line of defence: a
 * send wrapped in dispatchOnce must refuse a non-WhatsApp conversation before
 * dispatching (as automations' resolveConversationId does), or this refusal
 * leaves an 'unknown' outbound intent for a message that was never sent.
 */
export async function loadConversationSenderConfig(
  db: Db,
  accountId: string,
  conversationId: string
): Promise<SenderConfigRow> {
  const { data } = await db
    .from('conversations')
    .select('whatsapp_config_id,channel')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  const row = data as { whatsapp_config_id?: string | null; channel?: string | null } | null;
  if (row) assertWhatsAppConversation({ channel: row.channel });
  return loadSenderConfig(db, accountId, row?.whatsapp_config_id ?? null);
}

/** A template synced from another WABA than the sending number's. */
export class TemplateNumberMismatchError extends Error {
  readonly code = 'template_wrong_number';
  readonly messageKey = 'whatsappNumbers.errors.templateWrongNumber';
  constructor() {
    super('This template belongs to another WhatsApp Business account than the sending number. Choose a template from that number’s account.');
    this.name = 'TemplateNumberMismatchError';
  }
}

/**
 * Refuse a template stamped with a different WABA than the sending number.
 * A template or number without a WABA (rows from before multi-number) passes,
 * so single-number workspaces behave as before.
 */
export function assertTemplateOnNumber(
  template: object | null | undefined,
  config: object
): void {
  // MessageTemplate predates the column, so the stamp is read off the row.
  const templateWaba = (template as { waba_id?: string | null } | null | undefined)?.waba_id ?? null;
  const numberWaba = (config as { waba_id?: string | null }).waba_id ?? null;
  if (templateWaba && numberWaba && templateWaba !== numberWaba) throw new TemplateNumberMismatchError();
}

/** The catalogue string at `key`, or undefined when this build has none yet. */
function catalogueHas(key: string): boolean {
  let node: unknown = activeMessages;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

/** Localised text for a number error, falling back to the English message. */
export function numberErrorText(error: NoNumberError | TemplateNumberMismatchError, values?: TranslateValues): string {
  const key = error.messageKey;
  if (!catalogueHas(key)) return error.message;
  const dot = key.lastIndexOf('.');
  return getT(key.slice(0, dot))(key.slice(dot + 1), values);
}

export function isNumberError(error: unknown): error is NoNumberError | TemplateNumberMismatchError {
  return error instanceof NoNumberError || error instanceof TemplateNumberMismatchError;
}
