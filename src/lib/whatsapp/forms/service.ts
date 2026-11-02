/**
 * WhatsApp Forms service: the server side of /api/whatsapp/forms/**.
 *
 * Every query runs inside withTenant with the caller's live session, so
 * FORCE RLS scopes reads to the account and limits form writes to admins.
 * Each lookup also filters on account_id, so another account's id is a
 * plain "not found". None of the three form tables is a browser resource;
 * these functions are the only way the browser reaches them, and nothing
 * here ever selects the whatsapp_config key columns beyond a presence check.
 *
 * Meta calls never run inside a database transaction. Publishing persists
 * the Meta flow id the moment Meta returns it, so a retry resumes on the same
 * flow. A failed id write deletes the new flow (best effort); only a crash
 * between createFlow returning and that write can still leave a second,
 * untracked draft flow on the WABA.
 */

import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { appOrigin } from '@/lib/auth/csrf';
import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { csvCell } from '@/lib/audience/export';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  MetaApiError,
  createFlow,
  deleteFlow,
  deprecateFlow,
  getFlow,
  publishFlow,
  updateFlowMetadata,
  uploadFlowJson,
  type MetaFlowCategory,
  type MetaFlowValidationError,
} from '@/lib/whatsapp/meta-api';
import { emptyFormDefinition, validateFormDefinition } from './definition';
import { compileFlowJson, formInputFields } from './flow-json';
import {
  FORM_CATEGORIES,
  type FormCategory,
  type FormDefinition,
  type FormStatus,
  type FormValidationError,
  type WhatsAppForm,
} from './types';

const t = getT('Api');

export const FORM_NAME_MAX = 200;
export const RESPONSES_PAGE_DEFAULT = 50;
export const RESPONSES_PAGE_MAX = 100;
// shortcut: built in memory like the contact export; stream it if forms outgrow this cap.
export const MAX_RESPONSE_EXPORT_ROWS = 50_000;

/** Statuses whose Flow is live (or was) on Meta: its definition is frozen. */
const LOCKED_STATUSES: ReadonlySet<string> = new Set(['published', 'deprecated', 'blocked', 'throttled']);
const META_STATUS: Record<string, FormStatus> = {
  PUBLISHED: 'published',
  DEPRECATED: 'deprecated',
  BLOCKED: 'blocked',
  THROTTLED: 'throttled',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal with an HTTP status and a safe, translated message. */
export class FormServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors?: FormValidationError[] | MetaFlowValidationError[],
  ) {
    super(message);
    this.name = 'FormServiceError';
  }
}

export const isFormId = (value: string): boolean => UUID_RE.test(value);

const notFound = () => new FormServiceError(404, t('forms.notFound'));

/**
 * Writes are admin-only. RLS refuses the local write anyway, but publish and
 * delete call Meta first, so the role is checked before anything runs.
 */
function assertAdmin(ctx: TenantContext): string {
  if (!ctx.userId || !ctx.role || !hasMinRole(ctx.role, 'admin')) throw new FormServiceError(403, t('forms.adminOnly'));
  return ctx.userId;
}

type FormRow = Prisma.whatsapp_formsGetPayload<object>;

function serialiseForm(row: FormRow): WhatsAppForm {
  return {
    id: row.id,
    account_id: row.account_id,
    name: row.name,
    category: row.category as FormCategory,
    definition: row.definition as unknown as FormDefinition,
    flow_json: (row.flow_json as Record<string, unknown> | null) ?? null,
    meta_flow_id: row.meta_flow_id,
    status: row.status as FormStatus,
    validation_errors: (row.validation_errors as unknown as WhatsAppForm['validation_errors']) ?? null,
    preview_url: row.preview_url,
    uses_endpoint: row.uses_endpoint,
    published_at: row.published_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function findForm(tx: TenantTransaction, ctx: TenantContext, id: string): Promise<FormRow> {
  if (!isFormId(id)) throw notFound();
  const row = await tx.whatsapp_forms.findFirst({ where: { id, account_id: ctx.accountId } });
  if (!row) throw notFound();
  return row;
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// ---------------------------------------------------------------- input

export interface FormInput {
  name?: string;
  category?: FormCategory;
  definition?: FormDefinition;
  uses_endpoint?: boolean;
}

/**
 * Checks a create/update body. `partial` allows every field to be absent
 * (PUT); a definition is validated and returned normalised.
 */
export function parseFormInput(body: unknown, partial: boolean): FormInput {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!raw) throw new FormServiceError(400, t('forms.invalidBody'));
  const input: FormInput = {};
  if (raw.name !== undefined || !partial) {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > FORM_NAME_MAX) throw new FormServiceError(400, t('forms.nameInvalid', { max: FORM_NAME_MAX }));
    input.name = name;
  }
  if (raw.category !== undefined || !partial) {
    if (!FORM_CATEGORIES.includes(raw.category as FormCategory)) throw new FormServiceError(400, t('forms.categoryInvalid'));
    input.category = raw.category as FormCategory;
  }
  if (raw.uses_endpoint !== undefined) {
    if (typeof raw.uses_endpoint !== 'boolean') throw new FormServiceError(400, t('forms.invalidBody'));
    input.uses_endpoint = raw.uses_endpoint;
  }
  if (raw.definition !== undefined) {
    const result = validateFormDefinition(raw.definition);
    if (!result.ok) throw new FormServiceError(422, t('forms.definitionInvalid'), result.errors);
    input.definition = result.definition;
  }
  return input;
}

// ---------------------------------------------------------------- CRUD

export interface FormSummary {
  id: string;
  name: string;
  category: FormCategory;
  status: FormStatus;
  meta_flow_id: string | null;
  uses_endpoint: boolean;
  published_at: string | null;
  updated_at: string;
  response_count: number;
}

export async function listForms(ctx: TenantContext): Promise<FormSummary[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.whatsapp_forms.findMany({
      where: { account_id: ctx.accountId },
      select: {
        id: true, name: true, category: true, status: true, meta_flow_id: true,
        uses_endpoint: true, published_at: true, updated_at: true,
      },
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
    });
    if (rows.length === 0) return [];
    const counts = await tx.whatsapp_form_responses.groupBy({
      by: ['form_id'],
      where: { account_id: ctx.accountId, form_id: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const byForm = new Map(counts.map((c) => [c.form_id, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category as FormCategory,
      status: r.status as FormStatus,
      meta_flow_id: r.meta_flow_id,
      uses_endpoint: r.uses_endpoint,
      published_at: r.published_at?.toISOString() ?? null,
      updated_at: r.updated_at.toISOString(),
      response_count: byForm.get(r.id) ?? 0,
    }));
  });
}

export async function getForm(ctx: TenantContext, id: string): Promise<WhatsAppForm> {
  return withTenant(ctx, async (tx) => serialiseForm(await findForm(tx, ctx, id)));
}

export async function createForm(ctx: TenantContext, input: FormInput): Promise<WhatsAppForm> {
  const userId = assertAdmin(ctx);
  try {
    return await withTenant(ctx, async (tx) => serialiseForm(await tx.whatsapp_forms.create({
      data: {
        account_id: ctx.accountId,
        user_id: userId,
        name: input.name!,
        category: input.category!,
        definition: (input.definition ?? emptyFormDefinition()) as unknown as Prisma.InputJsonValue,
        uses_endpoint: input.uses_endpoint ?? false,
      },
    })));
  } catch (err) {
    if (isUniqueViolation(err)) throw new FormServiceError(409, t('forms.nameTaken'));
    throw err;
  }
}

export async function updateForm(ctx: TenantContext, id: string, input: FormInput): Promise<WhatsAppForm> {
  assertAdmin(ctx);
  try {
    return await withTenant(ctx, async (tx) => {
      const existing = await findForm(tx, ctx, id);
      const changesFlow = input.definition !== undefined
        || (input.uses_endpoint !== undefined && input.uses_endpoint !== existing.uses_endpoint);
      if (changesFlow && LOCKED_STATUSES.has(existing.status)) throw new FormServiceError(409, t('forms.publishedLocked'));
      const data: Prisma.whatsapp_formsUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.category !== undefined) data.category = input.category;
      if (input.uses_endpoint !== undefined) data.uses_endpoint = input.uses_endpoint;
      if (input.definition !== undefined) {
        data.definition = input.definition as unknown as Prisma.InputJsonValue;
        // Meta's errors described the previous definition.
        data.validation_errors = Prisma.DbNull;
      }
      if (Object.keys(data).length === 0) return serialiseForm(existing);
      return serialiseForm(await tx.whatsapp_forms.update({ where: { id: existing.id }, data }));
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new FormServiceError(409, t('forms.nameTaken'));
    throw err;
  }
}

/** `<name> (copy)`, then `(copy 2)`, ... trimmed so it fits FORM_NAME_MAX. */
export function duplicateFormName(name: string, taken: ReadonlySet<string>): string | null {
  for (let n = 1; n <= 100; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const candidate = `${name.slice(0, FORM_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

export async function duplicateForm(ctx: TenantContext, id: string): Promise<WhatsAppForm> {
  const userId = assertAdmin(ctx);
  try {
    return await withTenant(ctx, async (tx) => {
      const source = await findForm(tx, ctx, id);
      const base = source.name.slice(0, FORM_NAME_MAX - ' (copy 100)'.length).trimEnd();
      const siblings = await tx.whatsapp_forms.findMany({
        where: { account_id: ctx.accountId, name: { startsWith: base } },
        select: { name: true },
      });
      const name = duplicateFormName(source.name, new Set(siblings.map((s) => s.name)));
      if (!name) throw new FormServiceError(409, t('forms.nameTaken'));
      return serialiseForm(await tx.whatsapp_forms.create({
        data: {
          account_id: ctx.accountId,
          user_id: userId,
          name,
          category: source.category,
          definition: source.definition as Prisma.InputJsonValue,
          uses_endpoint: source.uses_endpoint,
        },
      }));
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new FormServiceError(409, t('forms.nameTaken'));
    throw err;
  }
}

// ---------------------------------------------------------------- Meta

interface MetaAccess {
  wabaId: string;
  accessToken: string;
  hasFormsKey: boolean;
}

/** The number's Meta credentials, or a 409 when WhatsApp is not connected. */
async function metaAccess(tx: TenantTransaction, ctx: TenantContext): Promise<MetaAccess> {
  const config = await tx.whatsapp_config.findFirst({
    where: { account_id: ctx.accountId },
    select: { waba_id: true, access_token: true, status: true, forms_key_uploaded_at: true, forms_private_key_enc: true },
  });
  if (!config || config.status !== 'connected' || !config.waba_id || !config.access_token) {
    throw new FormServiceError(409, t('forms.whatsappNotConnected'));
  }
  return {
    wabaId: config.waba_id,
    accessToken: config.access_token,
    hasFormsKey: Boolean(config.forms_private_key_enc && config.forms_key_uploaded_at),
  };
}

/** Meta's own message is safe to show (it carries no token); anything else is generic. */
function metaFailure(err: unknown, fallbackKey: string): FormServiceError {
  const message = err instanceof MetaApiError && err.message ? err.message : t(fallbackKey);
  return new FormServiceError(502, message);
}

function decryptToken(encrypted: string): string {
  try {
    return decrypt(encrypted);
  } catch {
    throw new FormServiceError(409, t('forms.whatsappNotConnected'));
  }
}

/** Meta's data-exchange URL for endpoint-backed forms (the endpoint route decrypts per account). */
export function formEndpointUri(accountId: string): string {
  return `${appOrigin()}/api/whatsapp/forms/endpoint/${accountId}`;
}

/**
 * Deletes the form on Meta first (deprecating it when it was published,
 * deleting it while it is still a Meta draft) and only then locally. A Meta
 * failure is a 502 and nothing is deleted. Stored responses stay, detached.
 */
export async function deleteForm(ctx: TenantContext, id: string): Promise<void> {
  assertAdmin(ctx);
  const { form, access } = await withTenant(ctx, async (tx) => {
    const row = await findForm(tx, ctx, id);
    return { form: row, access: row.meta_flow_id ? await metaAccess(tx, ctx) : null };
  });
  if (form.meta_flow_id && access) {
    const args = { flowId: form.meta_flow_id, accessToken: decryptToken(access.accessToken) };
    try {
      if (form.status === 'published' || form.status === 'blocked' || form.status === 'throttled') await deprecateFlow(args);
      else if (form.status !== 'deprecated') await deleteFlow(args);
    } catch (err) {
      throw metaFailure(err, 'forms.metaDeleteFailed');
    }
  }
  await withTenant(ctx, (tx) => tx.whatsapp_forms.deleteMany({ where: { id: form.id, account_id: ctx.accountId } }));
}

/**
 * Compiles the form, uploads it to its Meta flow (created on first publish)
 * and publishes it. Meta validation errors are stored and returned as a 422.
 * Safe to retry at any point: an existing meta_flow_id is always reused, and
 * a flow Meta already published is only recorded.
 *
 * The compiled flow_json is stored before it is uploaded, and every write
 * after a Meta call only applies while the definition and uses_endpoint are
 * still the ones that were compiled. An edit made mid-publish is never
 * recorded as published, and a retry that finds Meta already published
 * refuses (409) when the stored upload differs from the current definition.
 */
export async function publishForm(ctx: TenantContext, id: string): Promise<WhatsAppForm> {
  assertAdmin(ctx);
  const { form, access } = await withTenant(ctx, async (tx) => {
    const row = await findForm(tx, ctx, id);
    return { form: row, access: LOCKED_STATUSES.has(row.status) ? null : await metaAccess(tx, ctx) };
  });
  if (!access) {
    if (form.status === 'published') return serialiseForm(form);
    throw new FormServiceError(409, t('forms.notPublishable'));
  }
  if (form.uses_endpoint && !access.hasFormsKey) throw new FormServiceError(409, t('forms.encryptionKeyMissing'));
  const valid = validateFormDefinition(form.definition);
  if (!valid.ok) throw new FormServiceError(422, t('forms.definitionInvalid'), valid.errors);
  const flowJson = compileFlowJson(valid.definition, { usesEndpoint: form.uses_endpoint });
  const accessToken = decryptToken(access.accessToken);
  const categories = [form.category as MetaFlowCategory];
  const endpointUri = form.uses_endpoint ? formEndpointUri(ctx.accountId) : undefined;
  // Every write below applies only to the definition that was compiled here.
  const unchanged: Prisma.whatsapp_formsWhereInput = {
    id: form.id,
    account_id: ctx.accountId,
    uses_endpoint: form.uses_endpoint,
    definition: { equals: form.definition as Prisma.InputJsonValue },
  };
  const storedJson = flowJson as unknown as Prisma.InputJsonValue;

  let flowId = form.meta_flow_id;
  let metaStatus = 'DRAFT';
  try {
    if (!flowId) {
      const created = await createFlow({ wabaId: access.wabaId, accessToken, name: form.name, categories, endpointUri });
      flowId = await claimFlowId(ctx, form.id, created.id, accessToken);
    } else {
      // A retry: Meta may have published before we could record it.
      metaStatus = (await getFlow({ flowId, accessToken, fields: ['status'] })).status;
      if (metaStatus === 'DRAFT') await updateFlowMetadata({ flowId, accessToken, name: form.name, categories, endpointUri });
    }
  } catch (err) {
    if (err instanceof FormServiceError) throw err;
    throw metaFailure(err, 'forms.metaPublishFailed');
  }

  if (metaStatus !== 'DRAFT') {
    // Meta published before we recorded it. Its Flow JSON is the stored one; a
    // definition edited since then would not match what customers submit.
    if (form.flow_json !== null && !isDeepStrictEqual(form.flow_json, JSON.parse(JSON.stringify(flowJson)))) {
      throw new FormServiceError(409, t('forms.publishedVersionDiffers'));
    }
  } else {
    const { count } = await withTenant(ctx, (tx) => tx.whatsapp_forms.updateMany({ where: unchanged, data: { flow_json: storedJson } }));
    if (count !== 1) throw new FormServiceError(409, t('forms.changedDuringPublish'));
    let validationErrors: MetaFlowValidationError[];
    try {
      validationErrors = (await uploadFlowJson({ flowId, accessToken, flowJson })).validation_errors;
    } catch (err) {
      throw metaFailure(err, 'forms.metaPublishFailed');
    }
    if (validationErrors.length > 0) {
      const stored = await withTenant(ctx, (tx) => tx.whatsapp_forms.updateMany({
        where: unchanged,
        data: { status: 'error', validation_errors: validationErrors as unknown as Prisma.InputJsonValue },
      }));
      if (stored.count !== 1) throw new FormServiceError(409, t('forms.changedDuringPublish'));
      throw new FormServiceError(422, t('forms.metaValidationFailed'), validationErrors);
    }
    try {
      await publishFlow({ flowId, accessToken });
    } catch (err) {
      throw metaFailure(err, 'forms.metaPublishFailed');
    }
  }

  // Published either way; status and preview are a best-effort refresh.
  let info: { status: string; preview_url?: string } = { status: 'PUBLISHED' };
  try {
    info = await getFlow({ flowId, accessToken });
  } catch {
    // keep the defaults
  }
  return withTenant(ctx, async (tx) => {
    const { count } = await tx.whatsapp_forms.updateMany({
      where: unchanged,
      data: {
        status: META_STATUS[info.status] ?? 'published',
        flow_json: storedJson,
        validation_errors: Prisma.DbNull,
        preview_url: info.preview_url ?? form.preview_url,
        published_at: form.published_at ?? new Date(),
      },
    });
    // Edited after Meta published: the stored flow_json still records what
    // Meta serves, and the form stays editable instead of locking the edit.
    if (count !== 1) throw new FormServiceError(409, t('forms.publishedVersionDiffers'));
    return serialiseForm(await findForm(tx, ctx, form.id));
  });
}

/**
 * Records a newly created Meta flow id before anything else happens. When a
 * concurrent publish recorded one first, ours is deleted (best effort) and
 * the recorded id wins, so a form never points at two flows.
 */
async function claimFlowId(ctx: TenantContext, formId: string, createdId: string, accessToken: string): Promise<string> {
  let winner: string | null;
  try {
    winner = await recordFlowId(ctx, formId, createdId);
  } catch (err) {
    // The write may still have committed (a lost commit acknowledgement), so
    // look before deleting: never delete a flow the form now points at.
    const recorded = await withTenant(ctx, (tx) => tx.whatsapp_forms.findFirst({
      where: { id: formId, account_id: ctx.accountId },
      select: { meta_flow_id: true },
    })).then((row) => ({ known: true as const, id: row?.meta_flow_id ?? null }), () => ({ known: false as const, id: null }));
    if (recorded.known && recorded.id === createdId) return createdId;
    // Unknown outcome: keep the flow rather than risk a dangling meta_flow_id.
    if (recorded.known) await deleteFlow({ flowId: createdId, accessToken }).catch(() => undefined);
    throw err;
  }
  if (winner === createdId) return createdId;
  await deleteFlow({ flowId: createdId, accessToken }).catch(() => undefined);
  if (!winner) throw notFound();
  return winner;
}

async function recordFlowId(ctx: TenantContext, formId: string, createdId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const { count } = await tx.whatsapp_forms.updateMany({
      where: { id: formId, account_id: ctx.accountId, meta_flow_id: null },
      data: { meta_flow_id: createdId },
    });
    if (count === 1) return createdId;
    const row = await tx.whatsapp_forms.findFirst({ where: { id: formId, account_id: ctx.accountId }, select: { meta_flow_id: true } });
    return row?.meta_flow_id ?? null;
  });
}

// ---------------------------------------------------------------- responses

export interface FormResponseItem {
  id: string;
  created_at: string;
  contact: { id: string; name: string | null; phone: string } | null;
  answers: Record<string, unknown>;
  labels: Record<string, string>;
}

/** Opaque cursor: the last row's created_at and id. */
const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  return id && isFormId(id) && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

/** A submission's answers keyed by the form's input fields (flow_token and unknown keys dropped). */
function answersOf(response: unknown, fieldIds: readonly string[]): Record<string, unknown> {
  const raw = response && typeof response === 'object' && !Array.isArray(response) ? (response as Record<string, unknown>) : {};
  const source = raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers)
    ? (raw.answers as Record<string, unknown>)
    : raw;
  const answers: Record<string, unknown> = {};
  for (const id of fieldIds) if (Object.hasOwn(source, id)) answers[id] = source[id];
  return answers;
}

function formLabels(definition: unknown): { ids: string[]; labels: Record<string, string>; options: Map<string, Map<string, string>> } {
  const fields = formInputFields(definition as FormDefinition);
  return {
    ids: fields.map((f) => f.id),
    labels: Object.fromEntries(fields.map((f) => [f.id, f.label])),
    options: new Map(fields.map((f) => [f.id, new Map((f.options ?? []).map((o) => [o.id, o.title]))])),
  };
}

export async function listResponses(
  ctx: TenantContext,
  id: string,
  opts: { cursor?: string | null; limit?: number | null },
): Promise<{ responses: FormResponseItem[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? RESPONSES_PAGE_DEFAULT) || RESPONSES_PAGE_DEFAULT, 1), RESPONSES_PAGE_MAX);
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !after) throw new FormServiceError(400, t('forms.invalidCursor'));
  return withTenant(ctx, async (tx) => {
    const form = await findForm(tx, ctx, id);
    const { ids, labels } = formLabels(form.definition);
    const rows = await tx.whatsapp_form_responses.findMany({
      where: {
        account_id: ctx.accountId,
        form_id: form.id,
        ...(after ? { OR: [{ created_at: { lt: after.createdAt } }, { created_at: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      select: { id: true, created_at: true, contact_id: true, response: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const contactIds = [...new Set(page.map((r) => r.contact_id).filter((c): c is string => Boolean(c)))];
    const contacts = contactIds.length
      ? await tx.contacts.findMany({ where: { account_id: ctx.accountId, id: { in: contactIds } }, select: { id: true, name: true, phone: true } })
      : [];
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const last = page[page.length - 1];
    return {
      responses: page.map((r) => ({
        id: r.id,
        created_at: r.created_at.toISOString(),
        contact: (r.contact_id && byId.get(r.contact_id)) || null,
        answers: answersOf(r.response, ids),
        labels,
      })),
      next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  });
}

/** A CSV cell for one answer: option ids become their titles, lists are joined. */
function answerCell(value: unknown, options: Map<string, string> | undefined): string {
  const one = (v: unknown) => (typeof v === 'string' && options?.get(v)) || (v === null || v === undefined ? '' : String(v));
  return Array.isArray(value) ? value.map(one).join('; ') : one(value);
}

/**
 * Every response of one form as CSV: submitted-at, contact name and phone,
 * then one column per question label. Formula-safe and audit-logged (row
 * count only, never answers).
 */
export async function exportResponsesCsv(ctx: TenantContext, id: string): Promise<{ csv: string; rows: number; name: string }> {
  assertAdmin(ctx);
  return withTenant(ctx, async (tx) => {
    const form = await findForm(tx, ctx, id);
    const where = { account_id: ctx.accountId, form_id: form.id };
    const count = await tx.whatsapp_form_responses.count({ where });
    if (count > MAX_RESPONSE_EXPORT_ROWS) {
      throw new FormServiceError(413, t('forms.exportTooLarge', { max: MAX_RESPONSE_EXPORT_ROWS }));
    }
    const { ids, labels, options } = formLabels(form.definition);
    const rows = await tx.whatsapp_form_responses.findMany({
      where,
      select: { created_at: true, contact_id: true, response: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((c): c is string => Boolean(c)))];
    const contacts = contactIds.length
      ? await tx.contacts.findMany({ where: { account_id: ctx.accountId, id: { in: contactIds } }, select: { id: true, name: true, phone: true } })
      : [];
    const byId = new Map(contacts.map((c) => [c.id, c]));

    // Raw insert: the app role may write audit rows but not read them back.
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${ctx.accountId}::uuid,${ctx.userId ?? null}::uuid,'whatsapp_forms.responses_export',${form.id},${JSON.stringify({ rows: rows.length })}::jsonb)`;

    const header = [t('forms.csvSubmittedAt'), t('forms.csvContactName'), t('forms.csvPhone'), ...ids.map((f) => labels[f])];
    const lines = rows.map((r) => {
      const contact = r.contact_id ? byId.get(r.contact_id) : undefined;
      const answers = answersOf(r.response, ids);
      return [r.created_at, contact?.name ?? '', contact?.phone ?? '', ...ids.map((f) => answerCell(answers[f], options.get(f)))]
        .map(csvCell)
        .join(',');
    });
    // BOM so spreadsheet apps read UTF-8 names correctly.
    return { csv: `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`, rows: rows.length, name: form.name };
  });
}

// ---------------------------------------------------------------- HTTP

/** A service refusal as `{ error, errors? }` with its status; anything else is the generic account error. */
export function formErrorResponse(err: unknown): NextResponse {
  if (err instanceof FormServiceError) {
    return NextResponse.json(err.errors ? { error: err.message, errors: err.errors } : { error: err.message }, { status: err.status });
  }
  return toErrorResponse(err);
}
