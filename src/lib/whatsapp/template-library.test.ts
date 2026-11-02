import { afterAll, describe, expect, it, vi } from 'vitest'
import en from '../../../messages/en.json'
import es from '../../../messages/es.json'
import ko from '../../../messages/ko.json'
import pt from '../../../messages/pt.json'

const ORIGINAL_LOCALE = process.env.NEXT_PUBLIC_APP_LOCALE

/** Loads the library and validator against one locale's catalogue. */
async function loadFor(locale: string, messages: unknown) {
  vi.resetModules()
  process.env.NEXT_PUBLIC_APP_LOCALE = locale
  vi.doMock('@app-messages', () => ({ default: messages }))
  const library = await import('./template-library')
  const validators = await import('./template-validators')
  const languages = await import('./template-languages')
  return { ...library, ...validators, ...languages }
}

afterAll(() => {
  vi.doUnmock('@app-messages')
  vi.resetModules()
  if (ORIGINAL_LOCALE === undefined) delete process.env.NEXT_PUBLIC_APP_LOCALE
  else process.env.NEXT_PUBLIC_APP_LOCALE = ORIGINAL_LOCALE
})

describe.each([['en', en], ['es', es], ['pt', pt], ['ko', ko]] as const)('%s template library', (locale, messages) => {
  it('offers at least 28 entries with unique slugs and names', async () => {
    const { listLibraryTemplates } = await loadFor(locale, messages)
    const list = listLibraryTemplates()
    expect(list.length).toBeGreaterThanOrEqual(28)
    expect(new Set(list.map(t => t.slug)).size).toBe(list.length)
    expect(new Set(list.map(t => t.name)).size).toBe(list.length)
  })

  it('every entry passes the standard template validator once its placeholders are replaced', async () => {
    const { listLibraryTemplates, libraryTemplatePayload, validateTemplatePayload, templateLanguageForAppLocale } =
      await loadFor(locale, messages)
    for (const tpl of listLibraryTemplates()) {
      const payload = libraryTemplatePayload(tpl, templateLanguageForAppLocale(locale))
      payload.buttons = payload.buttons?.map(b =>
        b.type === 'URL' ? { ...b, url: 'https://shop.test/orders' }
          : b.type === 'PHONE_NUMBER' ? { ...b, phone_number: '+14155550100' } : b)
      const result = validateTemplatePayload(payload)
      expect(result.headerVarCount, tpl.slug).toBe(0)
      expect(tpl.sample_values.body.length, tpl.slug).toBe(result.bodyVarCount)
      expect(result.bodyVarCount, tpl.slug).toBeGreaterThan(0)
    }
  })

  it('refuses to submit an entry that still has its placeholder link or number', async () => {
    const { listLibraryTemplates, libraryTemplatePayload, validateTemplatePayload, templateLanguageForAppLocale, LIBRARY_URL_PLACEHOLDER, LIBRARY_PHONE_PLACEHOLDER } =
      await loadFor(locale, messages)
    const { getT } = await import('@/lib/i18n/translate')
    const t = getT('Validation.templates')
    const withCta = listLibraryTemplates().filter(tpl => tpl.buttons?.some(b => b.type === 'URL' || b.type === 'PHONE_NUMBER'))
    expect(withCta.length).toBeGreaterThan(0)
    for (const tpl of withCta) {
      const n = tpl.buttons!.findIndex(b => b.type === 'URL' || b.type === 'PHONE_NUMBER') + 1
      const message = tpl.buttons![n - 1].type === 'URL'
        ? t('buttonPlaceholderUrl', { n, url: LIBRARY_URL_PLACEHOLDER })
        : t('buttonPlaceholderPhone', { n, phone: LIBRARY_PHONE_PLACEHOLDER })
      expect(() => validateTemplatePayload(libraryTemplatePayload(tpl, templateLanguageForAppLocale(locale))), tpl.slug).toThrow(message)
    }
  })

  it('never starts or ends a body with a variable', async () => {
    const { listLibraryTemplates } = await loadFor(locale, messages)
    for (const tpl of listLibraryTemplates()) {
      const body = tpl.body_text.trim()
      expect(body, tpl.slug).not.toMatch(/^\{\{\d+\}\}/)
      expect(body, tpl.slug).not.toMatch(/\{\{\d+\}\}$/)
    }
  })

  it('keeps variables contiguous and leaves no unresolved ICU params', async () => {
    const { listLibraryTemplates, extractVariableIndices } = await loadFor(locale, messages)
    for (const tpl of listLibraryTemplates()) {
      const indices = extractVariableIndices(tpl.body_text)
      expect(indices, tpl.slug).toEqual(indices.map((_, i) => i + 1))
      const visible = [tpl.title, tpl.description, tpl.header?.text, tpl.body_text, tpl.footer_text, ...(tpl.buttons ?? []).map(b => b.text)]
      for (const text of visible) expect(text ?? '', tpl.slug).not.toMatch(/\{v\d|TemplateLibrary\./)
      for (const s of tpl.sample_values.body) expect(s.trim(), tpl.slug).not.toBe('')
    }
  })

  it('uses only Marketing or Utility, known industries and placeholder CTAs', async () => {
    const { listLibraryTemplates, TEMPLATE_LIBRARY_INDUSTRIES, libraryIndustryLabel, LIBRARY_URL_PLACEHOLDER, LIBRARY_PHONE_PLACEHOLDER } =
      await loadFor(locale, messages)
    const list = listLibraryTemplates()
    for (const tpl of list) {
      expect(['Marketing', 'Utility'], tpl.slug).toContain(tpl.category)
      expect(TEMPLATE_LIBRARY_INDUSTRIES, tpl.slug).toContain(tpl.industry)
      for (const b of tpl.buttons ?? []) {
        if (b.type === 'URL') expect(b.url).toBe(LIBRARY_URL_PLACEHOLDER)
        if (b.type === 'PHONE_NUMBER') expect(b.phone_number).toBe(LIBRARY_PHONE_PLACEHOLDER)
      }
    }
    for (const industry of TEMPLATE_LIBRARY_INDUSTRIES) {
      expect(list.some(t => t.industry === industry), industry).toBe(true)
      expect(libraryIndustryLabel(industry)).not.toBe(`TemplateLibrary.industries.${industry}`)
    }
  })
})
