// Pure helpers for the AI page's Assistant features tab (unit-tested).

export type FeatureKey = 'summary' | 'suggest' | 'assess' | 'insights' | 'label' | 'translate' | 'route'
export type SettingKey = 'summaries_enabled' | 'suggestions_enabled' | 'assessment_enabled' | 'insights_enabled'
  | 'labelling_enabled' | 'translation_enabled' | 'route_to_staff_enabled'

/** Each feature row and the workspace switch it flips, in the order shown. */
export const FEATURES: { key: FeatureKey; setting: SettingKey }[] = [
  { key: 'suggest', setting: 'suggestions_enabled' },
  { key: 'summary', setting: 'summaries_enabled' },
  { key: 'assess', setting: 'assessment_enabled' },
  { key: 'label', setting: 'labelling_enabled' },
  { key: 'translate', setting: 'translation_enabled' },
  { key: 'route', setting: 'route_to_staff_enabled' },
  { key: 'insights', setting: 'insights_enabled' },
]

export const TEAM_LANGUAGES = ['en', 'hi', 'te', 'ta', 'mr', 'kn', 'ml', 'bn', 'gu', 'pa', 'es', 'pt', 'ko', 'fr', 'de', 'ar'] as const
export type TeamLanguage = (typeof TEAM_LANGUAGES)[number]

export const LIMIT_PRESETS = [1_000_000, 3_000_000, 5_000_000, 10_000_000] as const
export const MIN_LIMIT = 100_000
export const MAX_LIMIT = 1_000_000_000_000

/** The typed monthly limit: a whole number of tokens (commas and spaces allowed), or an error key. */
export function parseLimit(raw: string): { ok: true; value: number } | { ok: false; error: 'invalid' | 'min' | 'max' } {
  const text = raw.trim().replace(/[,\s_]/g, '')
  if (!/^\d+$/.test(text)) return { ok: false, error: 'invalid' }
  const n = Number(text)
  if (!Number.isSafeInteger(n)) return { ok: false, error: 'max' }
  if (n < MIN_LIMIT) return { ok: false, error: 'min' }
  if (n > MAX_LIMIT) return { ok: false, error: 'max' }
  return { ok: true, value: n }
}

/** Percent of the limit used (0 without a limit); can exceed 100. */
export const usedPct = (used: number, limit: number | null): number => (limit && limit > 0 ? Math.round((used / limit) * 100) : 0)
