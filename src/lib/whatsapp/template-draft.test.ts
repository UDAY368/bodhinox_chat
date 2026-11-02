import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_NAME_MAX_ATTEMPTS,
  TEMPLATE_DRAFT_LIMITS,
  duplicateTemplateName,
  parseTemplateDraft,
} from './template-draft'

const base = { name: 'spring_sale', language: 'en_US', category: 'Marketing' }

describe('parseTemplateDraft', () => {
  it('accepts an incomplete draft with only its identity', () => {
    const r = parseTemplateDraft(base)
    expect(r).toEqual({
      ok: true,
      id: null,
      payload: { ...base, template_kind: 'standard', body_text: '' },
    })
  })

  it('keeps the known content fields and drops everything else', () => {
    const r = parseTemplateDraft({
      ...base,
      id: '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      template_kind: 'carousel',
      body_text: 'Pick one {{1}}',
      cards: [{ header_type: 'image', body_text: 'x', buttons: [] }],
      buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }],
      sample_values: { body: ['Ana'] },
      status: 'APPROVED',
      meta_template_id: 'meta-1',
      account_id: 'someone-else',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.id).toBe('3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f')
    expect(r.payload).not.toHaveProperty('status')
    expect(r.payload).not.toHaveProperty('meta_template_id')
    expect(r.payload).not.toHaveProperty('account_id')
    expect(r.payload.cards).toHaveLength(1)
    expect(r.payload.body_text).toBe('Pick one {{1}}')
  })

  it.each([
    ['a non-object body', []],
    ['an invalid name', { ...base, name: 'Spring Sale' }],
    ['a missing name', { language: 'en_US', category: 'Marketing' }],
    ['an invalid language', { ...base, language: 'english' }],
    ['an unknown category', { ...base, category: 'Promo' }],
    ['an unknown kind', { ...base, template_kind: 'poll' }],
    ['authentication kind outside its category', { ...base, template_kind: 'authentication' }],
    ['Authentication category on another kind', { ...base, category: 'Authentication' }],
    ['an unknown header type', { ...base, header_type: 'sticker' }],
    ['a non-string body', { ...base, body_text: 42 }],
    ['an over-long body', { ...base, body_text: 'x'.repeat(TEMPLATE_DRAFT_LIMITS.maxTextLength + 1) }],
    ['buttons that are not objects', { ...base, buttons: ['Yes'] }],
    ['too many cards', { ...base, template_kind: 'carousel', cards: Array.from({ length: 11 }, () => ({})) }],
    ['array auth options', { ...base, category: 'Authentication', template_kind: 'authentication', auth_options: [] }],
    ['a non-string id', { ...base, id: 7 }],
    ['an oversized draft', { ...base, sample_values: { body: ['x'.repeat(TEMPLATE_DRAFT_LIMITS.maxBytes)] } }],
  ])('rejects %s', (_label, body) => {
    expect(parseTemplateDraft(body).ok).toBe(false)
  })

  it('accepts an authentication draft in the Authentication category', () => {
    const r = parseTemplateDraft({
      ...base,
      category: 'Authentication',
      template_kind: 'authentication',
      auth_options: { otp_type: 'COPY_CODE' },
    })
    expect(r.ok).toBe(true)
  })
})

describe('duplicateTemplateName', () => {
  it('appends _copy, then numbered copies', () => {
    expect(duplicateTemplateName('promo', new Set(['promo']))).toBe('promo_copy')
    expect(duplicateTemplateName('promo', new Set(['promo', 'promo_copy']))).toBe('promo_copy_2')
    expect(
      duplicateTemplateName('promo', new Set(['promo_copy', 'promo_copy_2', 'promo_copy_3'])),
    ).toBe('promo_copy_4')
  })

  it('shortens the stem so the copy stays within 512 characters', () => {
    const long = 'a'.repeat(512)
    const first = duplicateTemplateName(long, new Set())!
    expect(first).toHaveLength(512)
    expect(first.endsWith('_copy')).toBe(true)
    const second = duplicateTemplateName(long, new Set([first]))!
    expect(second).toHaveLength(512)
    expect(second.endsWith('_copy_2')).toBe(true)
  })

  it('gives up when every candidate is taken', () => {
    const taken = new Set(['x_copy'])
    for (let n = 2; n <= DUPLICATE_NAME_MAX_ATTEMPTS; n++) taken.add(`x_copy_${n}`)
    expect(duplicateTemplateName('x', taken)).toBeNull()
  })
})
