// Outbound HTTP to customer-configured URLs (flow API Request node).
// Every connection resolves the host through `safeLookup`, so the address
// actually dialled is checked, which also closes the DNS-rebinding gap
// `isDeliverableUrl` documents, and keeps DNS inside the deadline. Redirects are never followed; the body is
// read to a size cap; the whole exchange shares one deadline.

import { lookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { assertJobLease } from '@/lib/jobs/lease'
import { isPrivateOrReservedIp } from './ssrf'

export const SAFE_FETCH_TIMEOUT_MS = 10_000
export const SAFE_FETCH_MAX_BYTES = 256 * 1024

export type SafeFetchResult =
  | { ok: true; status: number; contentType: string; body: string }
  | { ok: false; error: 'invalid_url' | 'blocked' | 'timeout' | 'too_large' | 'network' }

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/** dns.lookup that refuses private and reserved addresses. */
export function safeLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void {
  lookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, [])
    if (!addresses.length || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
      return callback(Object.assign(new Error('Destination not allowed'), { code: 'EBLOCKED' }), [])
    }
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

/** Names that resolve inside the network (the same rule as isDeliverableUrl). */
function isLocalName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
}

export async function safeFetch(
  rawUrl: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  { timeoutMs = SAFE_FETCH_TIMEOUT_MS, maxBytes = SAFE_FETCH_MAX_BYTES } = {},
): Promise<SafeFetchResult> {
  let url: URL
  try { url = new URL(rawUrl) } catch { return { ok: false, error: 'invalid_url' } }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return { ok: false, error: 'invalid_url' }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  // Literal IPs never reach the lookup and local names must not be tried.
  // Every other host is checked by safeLookup, inside the deadline below.
  if (isIP(host) ? isPrivateOrReservedIp(host) : isLocalName(host)) return { ok: false, error: 'blocked' }
  assertJobLease()
  return new Promise((resolve) => {
    let settled = false
    let req: http.ClientRequest | undefined
    const done = (result: SafeFetchResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req?.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs)
    const client = url.protocol === 'https:' ? https : http
    try {
    req = client.request(url, {
      method: init.method,
      headers: init.headers,
      // An IP literal skips DNS; it was checked above.
      ...(isIP(host) ? {} : { lookup: safeLookup as unknown as typeof lookup }),
    }, (res) => {
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) return done({ ok: false, error: 'too_large' })
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) return done({ ok: false, error: 'too_large' })
        chunks.push(chunk)
      })
      res.on('end', () => done({
        ok: true,
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }))
      res.on('error', () => done({ ok: false, error: 'network' }))
    })
    } catch {
      // Node rejects header names or values with control characters synchronously.
      return done({ ok: false, error: 'invalid_url' })
    }
    req.on('error', (err: NodeJS.ErrnoException) => done({ ok: false, error: err.code === 'EBLOCKED' ? 'blocked' : 'network' }))
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}
