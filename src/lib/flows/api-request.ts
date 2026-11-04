// The flow API Request step, shared by the engine and the editor's
// "Test request" route so both send exactly the same request.

import { safeFetch, type SafeFetchResult } from '@/lib/webhooks/safe-fetch'
import type { ApiRequestNodeConfig } from './types'

export interface RequestValues {
  vars: Record<string, unknown>
  /** name / email / phone / company of the run's contact. */
  contact: Record<string, string>
  /** Workspace attributes including secrets: only headers and the body use these. */
  workspace: Record<string, string>
  /** Workspace attributes without secrets, for the URL and query, which tend to end up in logs. */
  publicWorkspace: Record<string, string>
}

export const MAX_ROUTES = 5
export const MAX_MAPPED_LENGTH = 1000
const TOKEN = /\{\{\s*(vars|contact|workspace)\.([a-zA-Z0-9_]+)\s*\}\}/g
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function fill(text: string, values: RequestValues, workspace: Record<string, string>, escape: (s: string) => string): string {
  return text.replace(TOKEN, (_, scope: string, key: string) => {
    const raw = scope === 'vars' ? values.vars[key] : scope === 'contact' ? values.contact[key] : workspace[key]
    return escape(raw === undefined || raw === null ? '' : String(raw))
  })
}

/** A value placed inside a JSON string literal (also used by the automation send_webhook body). */
export const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1)
// Header values may not carry line breaks (request splitting).
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, ' ')

/** The request to send, or null when the filled-in URL is not an http(s) URL. */
export function buildApiRequest(cfg: ApiRequestNodeConfig, values: RequestValues): { url: string; method: string; headers: Record<string, string>; body?: string } | null {
  let url: URL
  try {
    url = new URL(fill(cfg.url.trim(), values, values.publicWorkspace, encodeURIComponent))
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  for (const { key, value } of cfg.params ?? []) {
    if (key.trim()) url.searchParams.append(key.trim(), fill(value, values, values.publicWorkspace, (s) => s))
  }
  const headers: Record<string, string> = { 'user-agent': 'Bodhinox-Flows/1.0', accept: 'application/json' }
  const sendsBody = cfg.method !== 'GET' && cfg.method !== 'DELETE' && Boolean(cfg.body?.trim())
  if (sendsBody) headers['content-type'] = 'application/json'
  for (const { key, value } of cfg.headers ?? []) {
    if (key.trim()) headers[key.trim().toLowerCase()] = headerSafe(fill(value, values, values.workspace, headerSafe))
  }
  return {
    url: url.toString(),
    method: cfg.method,
    headers,
    ...(sendsBody ? { body: fill(cfg.body!, values, values.workspace, jsonEscape) } : {}),
  }
}

/** Reads a dot path (`data.items.0.id`) from parsed JSON; prototype keys are never followed. */
export function readPath(value: unknown, path: string): unknown {
  let current = value
  for (const part of path.split('.')) {
    if (!part || UNSAFE_KEYS.has(part) || current === null || typeof current !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Mapped variables from a JSON reply; paths that are missing (or a non-JSON reply) set nothing. */
export function mapResponse(body: string, mappings: ApiRequestNodeConfig['mappings']): Record<string, string> {
  if (!mappings?.length) return {}
  let json: unknown
  try { json = JSON.parse(body) } catch { return {} }
  const out: Record<string, string> = {}
  for (const { path, var_key } of mappings) {
    const value = readPath(json, path.trim())
    if (value === undefined || value === null || !var_key) continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    out[var_key] = text.slice(0, MAX_MAPPED_LENGTH)
  }
  return out
}

/** The first route whose status ("201") or class ("2xx") matches; otherwise the fallback. */
export function routeFor(cfg: ApiRequestNodeConfig, status: number | null): string {
  if (status !== null) {
    for (const route of (cfg.routes ?? []).slice(0, MAX_ROUTES)) {
      const want = route.status.trim().toLowerCase()
      if (want === String(status) || (/^[1-5]xx$/.test(want) && want[0] === String(status)[0])) return route.next_node_key
    }
  }
  return cfg.fallback_next
}

export interface ApiRequestOutcome {
  result: SafeFetchResult
  mapped: Record<string, string>
  next: string
  durationMs: number
}

export async function runApiRequest(cfg: ApiRequestNodeConfig, values: RequestValues): Promise<ApiRequestOutcome> {
  const started = Date.now()
  const request = buildApiRequest(cfg, values)
  const result: SafeFetchResult = request
    ? await safeFetch(request.url, request)
    : { ok: false, error: 'invalid_url' }
  const mapped = result.ok && result.status >= 200 && result.status < 300 ? mapResponse(result.body, cfg.mappings) : {}
  return { result, mapped, next: routeFor(cfg, result.ok ? result.status : null), durationMs: Date.now() - started }
}

/** Whether an API Request step's headers or body (where secrets resolve) name one of `secretKeys`. */
export function apiNodeUsesSecrets(config: Record<string, unknown>, secretKeys: Set<string>): boolean {
  const text = JSON.stringify([config.headers ?? [], config.body ?? ''])
  for (const match of text.matchAll(/\{\{\s*workspace\.([a-z][a-z0-9_]*)\s*\}\}/g)) {
    if (secretKeys.has(match[1])) return true
  }
  return false
}

/** JSON with object keys sorted, so a config compares equal after a jsonb round trip. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = value as Record<string, unknown>
    // Undefined members vanish in JSON, so they must not affect equality either.
    return `{${Object.keys(entries).filter((k) => entries[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
