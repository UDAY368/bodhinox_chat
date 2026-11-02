// Answer formats shared by the engine (server) and the flow validator (browser too).

/** YYYY-MM-DD, or day-first D/M/YYYY with / - or . separators; null when not a real date. */
export function parseDateInput(value: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value)
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dayFirst ? [dayFirst[3], dayFirst[2], dayFirst[1]] : []
  if (!y) return null
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null
  return date.toISOString().slice(0, 10)
}

/** A plain decimal number; a single comma is read as the decimal point. */
export function parseNumberInput(value: string): number | null {
  const normalized = value.replace(/\s/g, '').replace(/^(-?\d+),(\d+)$/, '$1.$2')
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}
