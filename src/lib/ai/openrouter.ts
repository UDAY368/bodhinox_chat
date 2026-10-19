/** Public preset metadata. API keys always use encrypted account settings. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_FREE_MODEL = 'openrouter/free'
export type OpenRouterModel = { id: string; name: string }

export function isOpenRouterBaseUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value.trim())
    return url.origin === 'https://openrouter.ai' && !url.username && !url.password && !url.search && !url.hash &&
      ['/api/v1', '/api/v1/chat/completions'].includes(url.pathname.replace(/\/+$/, ''))
  } catch { return false }
}

/** Free suffix plus zero advertised token prices; never offer a paid fallback. */
export function freeOpenRouterModels(value: unknown): OpenRouterModel[] {
  const models = new Map<string, OpenRouterModel>([[OPENROUTER_FREE_MODEL, { id: OPENROUTER_FREE_MODEL, name: 'Automatic free model (OpenRouter)' }]])
  const rows = value && typeof value === 'object' && 'data' in value && Array.isArray(value.data) ? value.data : []
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.endsWith(':free') || row.id.length > 256 ||
      row.pricing?.prompt == null || row.pricing?.completion == null ||
      Number(row.pricing.prompt) !== 0 || Number(row.pricing.completion) !== 0 ||
      (row.pricing.request != null && Number(row.pricing.request) !== 0) ||
      !Array.isArray(row.architecture?.input_modalities) || !row.architecture.input_modalities.includes('text') ||
      !Array.isArray(row.architecture?.output_modalities) || !row.architecture.output_modalities.includes('text')) continue
    models.set(row.id, { id: row.id, name: typeof row.name === 'string' ? row.name.slice(0, 256) : row.id })
  }
  return [models.get(OPENROUTER_FREE_MODEL)!, ...[...models.values()].filter(model => model.id !== OPENROUTER_FREE_MODEL).sort((a, b) => a.name.localeCompare(b.name))]
}
