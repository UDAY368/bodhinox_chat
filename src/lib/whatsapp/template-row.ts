/**
 * The content columns of a message_templates row, derived from a
 * TemplatePayload. Draft save, submit, edit and duplicate all write
 * these same columns, so adding a template field touches one spot.
 *
 * Kind-specific fields are stored only on their own kind (the
 * validators already reject them elsewhere; a draft is not fully
 * validated, so they are dropped here instead of persisted).
 */

import type { TemplatePayload } from './template-validators'
import { templateKindOf } from './template-validators'

export function templateRowFields(payload: TemplatePayload) {
  const kind = templateKindOf(payload)
  return {
    category: payload.category,
    template_kind: kind,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    // Authentication bodies are written by Meta; the column is NOT NULL.
    body_text: typeof payload.body_text === 'string' ? payload.body_text : '',
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    cards: kind === 'carousel' ? (payload.cards ?? null) : null,
    auth_options: kind === 'authentication' ? (payload.auth_options ?? null) : null,
    lto: kind === 'limited_time_offer' ? (payload.lto ?? null) : null,
  }
}

/** Columns copied when duplicating a stored template row. */
export const TEMPLATE_CONTENT_COLUMNS =
  'id, name, category, language, template_kind, header_type, header_content, header_media_url, header_handle, body_text, footer_text, buttons, sample_values, cards, auth_options, lto'
