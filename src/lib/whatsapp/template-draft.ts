/**
 * Parsing for locally saved template drafts
 * (POST /api/whatsapp/templates/draft).
 *
 * A draft may be incomplete, so only its identity is validated in full:
 * name (Meta's rules), language, category and kind, with the
 * Authentication category paired to the authentication kind exactly as
 * submit requires. Every other field is shape-checked only — the right
 * JSON type and a sane size — so a draft can't store something that
 * later breaks the editor; the full validators run on submit.
 *
 * Only known template fields are copied out, so a body can't smuggle
 * status, meta_template_id or account columns into the row.
 */

import type { MessageTemplate } from '@/types'
import { getT } from '@/lib/i18n/translate'
import {
  TEMPLATE_KINDS,
  validateTemplateName,
  type TemplatePayload,
} from './template-validators'

const t = getT('Api.templates.draft')

export const TEMPLATE_DRAFT_LIMITS = {
  /** Serialized draft content; generous next to Meta's per-field caps. */
  maxBytes: 64 * 1024,
  maxTextLength: 4096,
  maxUrlLength: 2048,
  maxButtons: 10,
  maxCards: 10,
} as const

const CATEGORIES: readonly MessageTemplate['category'][] = [
  'Marketing',
  'Utility',
  'Authentication',
]
const HEADER_TYPES: readonly NonNullable<MessageTemplate['header_type']>[] = [
  'text',
  'image',
  'video',
  'document',
  'location',
]
const LANGUAGE_RE = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/
/** Meta's template name limit (TEMPLATE_LIMITS.nameRegex). */
const TEMPLATE_NAME_MAX_LENGTH = 512

export type TemplateDraftParseResult =
  | { ok: true; id: string | null; payload: TemplatePayload }
  | { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseTemplateDraft(body: unknown): TemplateDraftParseResult {
  if (!isPlainObject(body)) return { ok: false, error: t('bodyInvalid') }
  if (JSON.stringify(body).length > TEMPLATE_DRAFT_LIMITS.maxBytes) {
    return { ok: false, error: t('tooLarge') }
  }
  const bad = (field: string) => ({ ok: false as const, error: t('fieldInvalid', { field }) })

  const id = body.id ?? null
  if (id !== null && typeof id !== 'string') return bad('id')

  if (typeof body.name !== 'string') return bad('name')
  try {
    validateTemplateName(body.name)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : t('fieldInvalid', { field: 'name' }) }
  }
  if (typeof body.language !== 'string' || !LANGUAGE_RE.test(body.language)) {
    return { ok: false, error: t('languageInvalid') }
  }
  const category = body.category as MessageTemplate['category']
  if (!CATEGORIES.includes(category)) return { ok: false, error: t('categoryInvalid') }
  const kind = body.template_kind ?? 'standard'
  if (!TEMPLATE_KINDS.includes(kind as never)) return { ok: false, error: t('kindInvalid') }
  if ((category === 'Authentication') !== (kind === 'authentication')) {
    return { ok: false, error: t('kindCategoryMismatch') }
  }

  const payload: TemplatePayload = {
    name: body.name,
    language: body.language,
    category,
    template_kind: kind as TemplatePayload['template_kind'],
    body_text: '',
  }

  const header = body.header_type ?? null
  if (header !== null) {
    if (!HEADER_TYPES.includes(header as never)) return bad('header_type')
    payload.header_type = header as TemplatePayload['header_type']
  }

  const texts: [keyof TemplatePayload, number][] = [
    ['header_content', TEMPLATE_DRAFT_LIMITS.maxTextLength],
    ['header_media_url', TEMPLATE_DRAFT_LIMITS.maxUrlLength],
    ['header_handle', TEMPLATE_DRAFT_LIMITS.maxTextLength],
    ['body_text', TEMPLATE_DRAFT_LIMITS.maxTextLength],
    ['footer_text', TEMPLATE_DRAFT_LIMITS.maxTextLength],
  ]
  for (const [field, max] of texts) {
    const v = body[field]
    if (v == null) continue
    if (typeof v !== 'string' || v.length > max) return bad(field)
    ;(payload as unknown as Record<string, unknown>)[field] = v
  }

  const lists: [keyof TemplatePayload, number][] = [
    ['buttons', TEMPLATE_DRAFT_LIMITS.maxButtons],
    ['cards', TEMPLATE_DRAFT_LIMITS.maxCards],
  ]
  for (const [field, max] of lists) {
    const v = body[field]
    if (v == null) continue
    if (!Array.isArray(v) || v.length > max || !v.every(isPlainObject)) return bad(field)
    ;(payload as unknown as Record<string, unknown>)[field] = v
  }

  for (const field of ['sample_values', 'auth_options', 'lto'] as const) {
    const v = body[field]
    if (v == null) continue
    if (!isPlainObject(v)) return bad(field)
    ;(payload as unknown as Record<string, unknown>)[field] = v
  }

  return { ok: true, id, payload }
}

/** Highest `_copy_N` suffix tried before giving up. */
export const DUPLICATE_NAME_MAX_ATTEMPTS = 100

/**
 * First free copy name for a duplicated template: `<name>_copy`, then
 * `<name>_copy_2`, `<name>_copy_3`, ... The stem is shortened so every
 * candidate stays within Meta's 512-character name limit. `taken` holds
 * the names already used in the account for the template's language.
 * Returns null when every candidate is taken.
 */
export function duplicateTemplateName(name: string, taken: ReadonlySet<string>): string | null {
  for (let n = 1; n <= DUPLICATE_NAME_MAX_ATTEMPTS; n++) {
    const suffix = n === 1 ? '_copy' : `_copy_${n}`
    const candidate = name.slice(0, TEMPLATE_NAME_MAX_LENGTH - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
  return null
}
