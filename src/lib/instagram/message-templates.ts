// Instagram message templates: a workspace's saved card and button messages,
// sent from the inbox inside Instagram's messaging window. Meta has no approved
// templates for Instagram, so these are Bodhinox's own layouts. Every write is
// checked against Instagram's limits (graph-limits.ts), and every send checks
// again (the stored row is never trusted). Rows live in
// instagram_message_templates under forced row-level security.
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import {
  INSTAGRAM_LIMITS,
  buttonTemplateFits,
  genericTemplateFits,
  utf8Bytes,
  validHttpsUrl,
  type IgGenericCard,
  type IgTemplateButton,
} from './graph-limits';

export type InstagramTemplateKind = 'cards' | 'button';

export type InstagramTemplatePayload =
  | { cards: IgGenericCard[] }
  | { text: string; buttons: IgTemplateButton[] };

export interface InstagramMessageTemplate {
  id: string;
  name: string;
  kind: InstagramTemplateKind;
  payload: InstagramTemplatePayload;
  updated_at: string;
}

/** A workspace keeps at most this many saved Instagram templates. */
export const MAX_INSTAGRAM_TEMPLATES = 100;
export const TEMPLATE_NAME_CHARS = 80;
/** The stored payload's size cap (the table's CHECK); long links can exceed it within Instagram's own limits. */
export const MAX_TEMPLATE_PAYLOAD_BYTES = 20000;

export type TemplateErrorCode = 'invalid_template' | 'too_large' | 'duplicate_name' | 'too_many' | 'not_found';

export class InstagramTemplateError extends Error {
  constructor(readonly code: TemplateErrorCode) {
    super(code);
    this.name = 'InstagramTemplateError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value.trim() : undefined);

/** The payload a reply button carries: never one of our own postback codes (ib:, menu:, ...). */
export function replyPayload(title: string): string {
  return `reply:${title}`.slice(0, INSTAGRAM_LIMITS.postbackPayloadChars);
}

/**
 * A member's button: a link (https) or a reply. A reply's payload is made here
 * from its title, so a member cannot send a code the flow engine would act on.
 */
function parseButton(value: unknown): IgTemplateButton {
  if (!isRecord(value)) throw new InstagramTemplateError('invalid_template');
  const title = str(value.title) ?? '';
  if (value.type === 'web_url') {
    const url = str(value.url);
    if (!validHttpsUrl(url)) throw new InstagramTemplateError('invalid_template');
    return { type: 'web_url', title, url };
  }
  if (value.type === 'reply' || value.type === 'postback') return { type: 'postback', title, payload: replyPayload(title) };
  throw new InstagramTemplateError('invalid_template');
}

function parseButtons(value: unknown, allowEmpty: boolean): IgTemplateButton[] {
  if (value === undefined && allowEmpty) return [];
  if (!Array.isArray(value) || value.length > INSTAGRAM_LIMITS.buttons) throw new InstagramTemplateError('invalid_template');
  return value.map(parseButton);
}

function parseCard(value: unknown): IgGenericCard {
  if (!isRecord(value)) throw new InstagramTemplateError('invalid_template');
  const card: IgGenericCard = { title: str(value.title) ?? '' };
  const subtitle = str(value.subtitle);
  if (subtitle) card.subtitle = subtitle;
  const imageUrl = str(value.imageUrl);
  if (imageUrl) card.imageUrl = imageUrl;
  const defaultUrl = str(value.defaultUrl);
  if (defaultUrl) card.defaultUrl = defaultUrl;
  const buttons = parseButtons(value.buttons, true);
  if (buttons.length) card.buttons = buttons;
  return card;
}

function sized<T extends { payload: InstagramTemplatePayload }>(template: T): T {
  if (utf8Bytes(JSON.stringify(template.payload)) > MAX_TEMPLATE_PAYLOAD_BYTES) throw new InstagramTemplateError('too_large');
  return template;
}

/** A template from a request body or a stored row; throws invalid_template unless it fits Instagram's limits. */
export function parseTemplatePayload(kind: unknown, payload: unknown): { kind: InstagramTemplateKind; payload: InstagramTemplatePayload } {
  if (!isRecord(payload)) throw new InstagramTemplateError('invalid_template');
  if (kind === 'cards') {
    if (!Array.isArray(payload.cards)) throw new InstagramTemplateError('invalid_template');
    const cards = payload.cards.map(parseCard);
    if (!genericTemplateFits(cards)) throw new InstagramTemplateError('invalid_template');
    return sized({ kind, payload: { cards } });
  }
  if (kind === 'button') {
    const text = str(payload.text) ?? '';
    const buttons = parseButtons(payload.buttons, false);
    if (!buttonTemplateFits(text, buttons)) throw new InstagramTemplateError('invalid_template');
    return sized({ kind, payload: { text, buttons } });
  }
  throw new InstagramTemplateError('invalid_template');
}

export function parseTemplateInput(body: unknown): { name: string; kind: InstagramTemplateKind; payload: InstagramTemplatePayload } {
  if (!isRecord(body)) throw new InstagramTemplateError('invalid_template');
  const name = str(body.name) ?? '';
  if (!name || name.length > TEMPLATE_NAME_CHARS) throw new InstagramTemplateError('invalid_template');
  return { name, ...parseTemplatePayload(body.kind, body.payload) };
}

/** The one line a template shows as in the conversation list and its picker. */
export function templatePreview(template: Pick<InstagramMessageTemplate, 'kind' | 'payload'>): string {
  return 'cards' in template.payload ? template.payload.cards[0]?.title ?? '' : template.payload.text;
}

type Row = { id: string; name: string; kind: string; payload: unknown; updated_at: Date };
const toTemplate = (row: Row): InstagramMessageTemplate | null => {
  try {
    const parsed = parseTemplatePayload(row.kind, row.payload);
    return { id: row.id, name: row.name, ...parsed, updated_at: row.updated_at.toISOString() };
  } catch {
    return null; // A row that no longer fits (limits changed) is hidden rather than sent.
  }
};

export function listInstagramTemplates(tenant: TenantContext): Promise<InstagramMessageTemplate[]> {
  return withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`SELECT id::text AS id, name, kind, payload, updated_at FROM instagram_message_templates
      WHERE account_id=${tenant.accountId}::uuid ORDER BY lower(name)`;
    return rows.map(toTemplate).filter((t): t is InstagramMessageTemplate => t !== null);
  });
}

/** One template of this workspace inside the caller's transaction (the composer send). */
export async function readInstagramTemplate(tx: TenantTransaction, accountId: string, id: string): Promise<InstagramMessageTemplate> {
  if (!UUID.test(id)) throw new InstagramTemplateError('not_found');
  const rows = await tx.$queryRaw<Row[]>`SELECT id::text AS id, name, kind, payload, updated_at FROM instagram_message_templates
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  const template = rows[0] ? toTemplate(rows[0]) : null;
  if (!template) throw new InstagramTemplateError('not_found');
  return template;
}

// A raw query surfaces Postgres's unique violation (23505) in the error message.
const isUniqueViolation = (error: unknown) => /23505|duplicate key|unique constraint/i.test(String((error as Error)?.message ?? ''));

export async function createInstagramTemplate(tenant: TenantContext & { userId: string }, body: unknown): Promise<InstagramMessageTemplate> {
  const input = parseTemplateInput(body);
  try {
    return await withTenant(tenant, async (tx) => {
      // One create at a time per workspace, so two at once cannot both pass the cap.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ig_templates:' + tenant.accountId}))`;
      const [{ count }] = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM instagram_message_templates
        WHERE account_id=${tenant.accountId}::uuid`;
      if (count >= MAX_INSTAGRAM_TEMPLATES) throw new InstagramTemplateError('too_many');
      const rows = await tx.$queryRaw<Row[]>`INSERT INTO instagram_message_templates(account_id,name,kind,payload,created_by)
        VALUES(${tenant.accountId}::uuid,${input.name},${input.kind},${JSON.stringify(input.payload)}::jsonb,${tenant.userId}::uuid)
        RETURNING id::text AS id, name, kind, payload, updated_at`;
      return toTemplate(rows[0])!;
    });
  } catch (error) {
    if (error instanceof InstagramTemplateError) throw error;
    if (isUniqueViolation(error)) throw new InstagramTemplateError('duplicate_name');
    throw error;
  }
}

export async function updateInstagramTemplate(tenant: TenantContext, id: string, body: unknown): Promise<InstagramMessageTemplate> {
  if (!UUID.test(id)) throw new InstagramTemplateError('not_found');
  const input = parseTemplateInput(body);
  try {
    return await withTenant(tenant, async (tx) => {
      const rows = await tx.$queryRaw<Row[]>`UPDATE instagram_message_templates
        SET name=${input.name}, kind=${input.kind}, payload=${JSON.stringify(input.payload)}::jsonb
        WHERE account_id=${tenant.accountId}::uuid AND id=${id}::uuid
        RETURNING id::text AS id, name, kind, payload, updated_at`;
      if (!rows[0]) throw new InstagramTemplateError('not_found');
      return toTemplate(rows[0])!;
    });
  } catch (error) {
    if (error instanceof InstagramTemplateError) throw error;
    if (isUniqueViolation(error)) throw new InstagramTemplateError('duplicate_name');
    throw error;
  }
}

export async function deleteInstagramTemplate(tenant: TenantContext, id: string): Promise<void> {
  if (!UUID.test(id)) throw new InstagramTemplateError('not_found');
  const deleted = await withTenant(tenant, (tx) =>
    tx.$executeRaw`DELETE FROM instagram_message_templates WHERE account_id=${tenant.accountId}::uuid AND id=${id}::uuid`);
  if (!deleted) throw new InstagramTemplateError('not_found');
}
