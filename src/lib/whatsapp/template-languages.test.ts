import { describe, expect, it } from 'vitest'
import { TEMPLATE_LANGUAGES, isTemplateLanguage, templateLanguageForAppLocale } from './template-languages'

/** Codes the old editor offered; templates saved with them must stay valid. */
const PREVIOUSLY_SUGGESTED = ['en_US', 'en_GB', 'en', 'es', 'es_ES', 'es_MX', 'fr', 'fr_FR', 'de', 'it', 'pt_BR', 'pt_PT', 'nl', 'pl', 'ru', 'tr', 'lt']

describe('template languages', () => {
  it('lists the full Meta set with unique codes, sorted by label', () => {
    expect(TEMPLATE_LANGUAGES.length).toBeGreaterThanOrEqual(70)
    expect(new Set(TEMPLATE_LANGUAGES.map(l => l.code)).size).toBe(TEMPLATE_LANGUAGES.length)
    const labels = TEMPLATE_LANGUAGES.map(l => l.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')))
    for (const l of TEMPLATE_LANGUAGES) expect(l.code).toMatch(/^[a-z]{2,3}(_[A-Z]{2})?$/)
  })

  it('still includes every code the old editor offered', () => {
    for (const code of PREVIOUSLY_SUGGESTED) expect(isTemplateLanguage(code), code).toBe(true)
  })

  it('rejects unknown codes', () => {
    expect(isTemplateLanguage('xx')).toBe(false)
    expect(isTemplateLanguage('EN_us')).toBe(false)
  })

  it('maps each app build locale to a listed template language', () => {
    expect(templateLanguageForAppLocale('en')).toBe('en_US')
    expect(templateLanguageForAppLocale('es')).toBe('es')
    expect(templateLanguageForAppLocale('pt')).toBe('pt_BR')
    expect(templateLanguageForAppLocale('ko')).toBe('ko')
    expect(templateLanguageForAppLocale('fr')).toBe('en_US')
    for (const locale of ['en', 'es', 'pt', 'ko']) expect(isTemplateLanguage(templateLanguageForAppLocale(locale))).toBe(true)
  })
})
