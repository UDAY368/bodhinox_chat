// Website and sitemap crawler for the AI knowledge base.
//
// Every request dials through safeLookup (src/lib/webhooks/safe-fetch.ts), so
// the address actually connected to is checked against private and reserved
// ranges at connect time; literal IPs and local names are refused before any
// connection, and only the default ports are allowed. Redirects are followed
// by hand (at most three), each hop re-checked for site and robots.txt.
//
// The crawl stays on the start URL's exact host (and its www./apex twin), honours robots.txt
// (a "BodhinoxBot" group, else "*"; Allow/Disallow by longest match), reads
// sitemaps and sitemap indexes, dedupes by canonical URL and by content, caps
// pages and bytes, and fetches two pages at a time with a delay between
// rounds. Work is done in time-boxed slices whose state is JSON, so the worker
// can persist it in a continuation job instead of holding the queue.
//
// All parsing of fetched bytes (robots patterns, sitemap <loc>, HTML) is
// linear-time: it runs synchronously on the shared worker, where no timeout,
// slice budget or job lease can interrupt a backtracking regex.
//
// Fetched text is customer data and untrusted: it is stored as knowledge and
// never logged, and the agent prompt treats it as reference data only.

import { createHash } from 'node:crypto'
import { lookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { assertJobLease } from '@/lib/jobs/lease'
import { isPrivateOrReservedIp } from '@/lib/webhooks/ssrf'
import { safeLookup } from '@/lib/webhooks/safe-fetch'

export const CRAWLER_USER_AGENT = 'Mozilla/5.0 (compatible; BodhinoxBot/1.0; +https://bodhinox.com/bot)'
/** The robots.txt product token we answer to (matched case-insensitively). */
export const CRAWLER_TOKEN = 'bodhinoxbot'
export const CRAWL_CONCURRENCY = 2
export const CRAWL_DELAY_MS = 600
/** robots.txt Crawl-delay is honoured up to this much. */
export const MAX_CRAWL_DELAY_MS = 5_000
export const FETCH_TIMEOUT_MS = 15_000
export const PAGE_MAX_BYTES = 2 * 1024 * 1024
export const SITEMAP_MAX_BYTES = 5 * 1024 * 1024
export const ROBOTS_MAX_BYTES = 512 * 1024
export const PAGE_TEXT_MAX_CHARS = 100_000
/** Pages shorter than this after extraction carry nothing worth indexing. */
export const MIN_PAGE_TEXT_CHARS = 40
export const MAX_URL_CHARS = 512
export const MAX_PENDING = 600
export const MAX_SITEMAPS = 25
export const MAX_HOSTS = 10
const MAX_REDIRECTS = 3
const MAX_ROBOTS_RULES = 300
/** A robots rule longer than this cannot match any URL we fetch (MAX_URL_CHARS) and is dropped. */
const MAX_ROBOTS_RULE_CHARS = 512
/** HTML beyond this is not read; page text is capped far lower anyway. */
export const HTML_EXTRACT_MAX_CHARS = 1024 * 1024
/** Tags longer than this are not parsed for attributes. */
const MAX_TAG_CHARS = 4096

// ================================================================ fetch

export type CrawlFetchError = 'invalid_url' | 'blocked' | 'timeout' | 'too_large' | 'network'
export type CrawlFetchResult =
  | { ok: true; status: number; contentType: string; location: string | null; body: Buffer; truncated?: boolean }
  | { ok: false; error: CrawlFetchError }
/** With `truncate`, a body over `maxBytes` is cut to its first `maxBytes` (truncated: true) instead of failing. */
export interface CrawlFetchOptions { maxBytes: number; accept: string; truncate?: boolean }
export type CrawlFetcher = (url: string, opts: CrawlFetchOptions) => Promise<CrawlFetchResult>

function isLocalName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || !host.includes('.')
}

/**
 * Pre-connection URL check: http(s) only, no credentials, default port only,
 * no private literal IP and no local name. Names that resolve to a private
 * address are refused later, by safeLookup, at connect time.
 */
export function checkCrawlUrl(raw: string): { ok: true; url: URL } | { ok: false; error: 'invalid_url' | 'blocked' } {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, error: 'invalid_url' } }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return { ok: false, error: 'invalid_url' }
  if (url.port !== '') return { ok: false, error: 'blocked' }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(host) ? isPrivateOrReservedIp(host) : isLocalName(host)) return { ok: false, error: 'blocked' }
  return { ok: true, url }
}

/** One GET, never following redirects; the body is read to a byte cap within one deadline. */
export async function crawlFetch(rawUrl: string, { maxBytes, accept, truncate = false }: CrawlFetchOptions,
  timeoutMs = FETCH_TIMEOUT_MS): Promise<CrawlFetchResult> {
  const checked = checkCrawlUrl(rawUrl)
  if (!checked.ok) return checked
  const url = checked.url
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  assertJobLease()
  return new Promise((resolve) => {
    let settled = false
    let req: http.ClientRequest | undefined
    const done = (result: CrawlFetchResult) => {
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
        method: 'GET',
        headers: { 'User-Agent': CRAWLER_USER_AGENT, Accept: accept, 'Accept-Encoding': 'identity' },
        ...(isIP(host) ? {} : { lookup: safeLookup as unknown as typeof lookup }),
      }, (res) => {
        const status = res.statusCode ?? 0
        const location = typeof res.headers.location === 'string' ? res.headers.location : null
        if (status >= 300 && status < 400) {
          return done({ ok: true, status, contentType: '', location, body: Buffer.alloc(0) })
        }
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase()
        const declared = Number(res.headers['content-length'])
        if (!truncate && Number.isFinite(declared) && declared > maxBytes) return done({ ok: false, error: 'too_large' })
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          if (size + chunk.length > maxBytes) {
            if (!truncate) return done({ ok: false, error: 'too_large' })
            chunks.push(chunk.subarray(0, maxBytes - size))
            return done({ ok: true, status, location, contentType, body: Buffer.concat(chunks), truncated: true })
          }
          size += chunk.length
          chunks.push(chunk)
        })
        res.on('end', () => done({ ok: true, status, location, contentType, body: Buffer.concat(chunks) }))
        res.on('error', () => done({ ok: false, error: 'network' }))
      })
    } catch {
      return done({ ok: false, error: 'invalid_url' })
    }
    req.on('error', (err: NodeJS.ErrnoException) => done({ ok: false, error: err.code === 'EBLOCKED' ? 'blocked' : 'network' }))
    req.end()
  })
}

export const defaultFetcher: CrawlFetcher = (url, opts) => crawlFetch(url, opts)

// ================================================================ URLs and sites

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
}

/**
 * The crawl scope of a start URL: its exact host. Only that host and its
 * www./apex twin are crawled; other subdomains are not, so a site on a shared
 * platform (x.up.railway.app, x.fly.dev, x.s3.amazonaws.com) never reaches
 * another customer's site there.
 */
export function crawlSite(hostname: string): string {
  return bareHost(hostname)
}

export function isSameSite(url: string, site: string): boolean {
  let host: string
  try { host = bareHost(new URL(url).hostname) } catch { return false }
  return host === site || host === `www.${site}` || `www.${host}` === site
}

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|igshid)$/i
const SKIP_EXTENSION = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|gz|tgz|7z|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|webm|mov|avi|css|js|mjs|json|xml|rss|atom|woff2?|ttf|eot|exe|dmg|apk|csv)$/i

/** Absolute http(s) URL without fragment, credentials or tracking parameters; null if unusable. */
export function canonicalizeUrl(raw: string, base?: string): string | null {
  let url: URL
  try { url = base ? new URL(raw, base) : new URL(raw) } catch { return null }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
  if (url.search === '?') url.search = ''
  const out = url.toString()
  return out.length <= MAX_URL_CHARS ? out : null
}

export function looksLikePage(url: string): boolean {
  try { return !SKIP_EXTENSION.test(new URL(url).pathname) } catch { return false }
}

export const shortHash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)
export const contentHash = (value: string): string => createHash('sha256').update(value).digest('hex')

// ================================================================ robots.txt

export interface RobotsRules { allow: string[]; disallow: string[]; crawlDelayMs: number }
export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [], crawlDelayMs: 0 }
export const DISALLOW_ALL: RobotsRules = { allow: [], disallow: ['/'], crawlDelayMs: 0 }

/**
 * Parses robots.txt for our crawler: the groups naming our product token, or
 * else the "*" groups (several matching groups are merged). Sitemap lines are
 * returned separately; they apply to the whole file.
 */
export function parseRobots(text: string, token = CRAWLER_TOKEN): RobotsRules & { sitemaps: string[] } {
  type Group = { agents: string[]; allow: string[]; disallow: string[]; delay: number }
  const groups: Group[] = []
  const sitemaps: string[] = []
  let current: Group | null = null
  let lastWasAgent = false
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n|\r/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === 'sitemap') { if (value && sitemaps.length < MAX_SITEMAPS) sitemaps.push(value); continue }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], allow: [], disallow: [], delay: 0 }; groups.push(current) }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!current) continue
    const rule = value.replace(/\*{2,}/g, '*')
    if ((field === 'allow' || field === 'disallow') && rule.length > MAX_ROBOTS_RULE_CHARS) continue
    if (field === 'allow' && rule && current.allow.length < MAX_ROBOTS_RULES) current.allow.push(rule)
    else if (field === 'disallow' && rule && current.disallow.length < MAX_ROBOTS_RULES) current.disallow.push(rule)
    else if (field === 'crawl-delay') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0) current.delay = Math.min(seconds * 1000, MAX_CRAWL_DELAY_MS)
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && a.length > 0 && token.toLowerCase().startsWith(a)))
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes('*'))
  return {
    allow: chosen.flatMap((g) => g.allow).slice(0, MAX_ROBOTS_RULES),
    disallow: chosen.flatMap((g) => g.disallow).slice(0, MAX_ROBOTS_RULES),
    crawlDelayMs: Math.max(0, ...chosen.map((g) => g.delay)),
    sitemaps,
  }
}

/**
 * RFC 9309 wildcard match ('*' any run, trailing '$' end of path) without a
 * regex: the first piece is a prefix, each middle piece is taken at its
 * leftmost place, and an anchored last piece must end the path. Leftmost
 * placement is exact for '*' globs and never backtracks.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split('*')
  const first = pieces[0]
  if (!path.startsWith(first)) return false
  if (pieces.length === 1) return !anchored || path.length === first.length
  let pos = first.length
  for (let i = 1; i < pieces.length - 1; i++) {
    const at = path.indexOf(pieces[i], pos)
    if (at < 0) return false
    pos = at + pieces[i].length
  }
  const last = pieces[pieces.length - 1]
  return anchored ? path.length - last.length >= pos && path.endsWith(last) : path.indexOf(last, pos) >= 0
}

/** Longest matching rule wins; on a tie Allow wins; no match allows. `path` includes the query. */
export function isAllowedByRobots(rules: RobotsRules, path: string): boolean {
  let best = -1
  let allowed = true
  for (const pattern of rules.disallow) {
    if (patternMatches(pattern, path) && pattern.length > best) { best = pattern.length; allowed = false }
  }
  for (const pattern of rules.allow) {
    if (patternMatches(pattern, path) && pattern.length >= best) { best = pattern.length; allowed = true }
  }
  return allowed
}

/** RFC 9309: a missing robots.txt (4xx) allows everything; an unreachable one (5xx, network) disallows everything. */
export async function loadRobots(origin: string, fetcher: CrawlFetcher): Promise<RobotsRules & { sitemaps: string[] }> {
  let target = `${origin}/robots.txt`
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // RFC 9309 2.5: a file over the cap is parsed up to the cap, not ignored;
    // if nothing at all can be read it is treated as unreachable.
    const res = await fetcher(target, { maxBytes: ROBOTS_MAX_BYTES, accept: 'text/plain,*/*;q=0.5', truncate: true })
    if (!res.ok) return { ...DISALLOW_ALL, sitemaps: [] }
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = canonicalizeUrl(res.location, target)
      if (!next) return { ...ALLOW_ALL, sitemaps: [] }
      target = next
      continue
    }
    if (res.status >= 200 && res.status < 300) {
      let text = res.body.toString('utf8')
      if (res.truncated || res.body.length >= ROBOTS_MAX_BYTES) {
        const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
        text = cut >= 0 ? text.slice(0, cut) : '' // the last line may be cut mid-rule
      }
      return parseRobots(text)
    }
    if (res.status >= 400 && res.status < 500) return { ...ALLOW_ALL, sitemaps: [] }
    return { ...DISALLOW_ALL, sitemaps: [] }
  }
  return { ...ALLOW_ALL, sitemaps: [] }
}

// ================================================================ sitemaps

function decodeXmlText(value: string): string {
  const v = value.trim()
  return decodeEntities(v.startsWith('<![CDATA[') && v.endsWith(']]>') ? v.slice(9, -3) : v).trim()
}

/** URLs and child sitemaps listed in a sitemap or sitemap index (an RSS/Atom feed is not read). */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml)
  const locs: string[] = []
  const open = /<loc>/gi
  const close = /<\/loc>/gi
  while (locs.length < 50_000 && open.exec(xml)) {
    close.lastIndex = open.lastIndex
    const c = close.exec(xml)
    if (!c) break // no later <loc> can close either
    locs.push(decodeXmlText(xml.slice(open.lastIndex, c.index)))
    open.lastIndex = close.lastIndex
  }
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] }
}

function bodyText(body: Buffer, url: string, contentType: string): string | null {
  const gz = body.length > 2 && body[0] === 0x1f && body[1] === 0x8b
  if (!gz) return body.toString('utf8')
  if (!/\.gz$/i.test(new URL(url).pathname) && !contentType.includes('gzip')) return null
  try { return gunzipSync(body, { maxOutputLength: SITEMAP_MAX_BYTES }).toString('utf8') } catch { return null }
}

// ================================================================ HTML extraction

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©',
  reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', euro: '€', pound: '£',
  yen: '¥', rupee: '₹', deg: '°', times: '×', laquo: '«', raquo: '»',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole
  })
}

// Every pattern below is linear: tag regexes are of the form `<x[^>]*>`,
// which can only fail by scanning to the end when no '>' follows, and
// closeTail() removes that case; elements are found by one opener search and
// one closer search, stopping (not retrying) when there is no closer.

/** Escapes each '<' after the last '>' so no tag regex can scan to the end and fail. */
function closeTail(s: string): string {
  const last = s.lastIndexOf('>')
  const at = s.indexOf('<', last + 1)
  return at < 0 ? s : s.slice(0, at) + s.slice(at).replaceAll('<', '&lt;')
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (tag.length > MAX_TAG_CHARS) return out
  // The lookbehind lets a name start only after a non-name character, so a
  // long run of name characters is scanned once, not once per position.
  const re = /(?<![-a-zA-Z0-9_:.])([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag)) !== null) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  return out
}

interface ElementSpan { start: number; innerStart: number; innerEnd: number; end: number }

/** The first `<tag ...>...</tag>` at or after `from` (case-insensitive); null when none closes. */
function findElement(s: string, tag: string, from: number, lastCloser = false): ElementSpan | null {
  const open = new RegExp(`<${tag}(?=[\\s/>])`, 'gi')
  open.lastIndex = from
  const m = open.exec(s)
  if (!m) return null
  const gt = s.indexOf('>', m.index + tag.length + 1)
  if (gt < 0) return null
  const close = new RegExp(`<\\/${tag}\\s*>`, 'gi')
  close.lastIndex = gt + 1
  let c = close.exec(s)
  if (!c) return null
  if (lastCloser) for (let next = close.exec(s); next; next = close.exec(s)) c = next
  return { start: m.index, innerStart: gt + 1, innerEnd: c.index, end: c.index + c[0].length }
}

/** Every `<tag>...</tag>` element, outermost-first and non-overlapping, in document order. */
function findElements(s: string, tag: string): ElementSpan[] {
  const out: ElementSpan[] = []
  for (let el = findElement(s, tag, 0); el; el = findElement(s, tag, el.end)) out.push(el)
  return out
}

function dropElements(html: string, tag: string): string {
  const spans = findElements(html, tag)
  if (!spans.length) return html
  const parts: string[] = []
  let pos = 0
  for (const el of spans) { parts.push(html.slice(pos, el.start), ' '); pos = el.end }
  parts.push(html.slice(pos))
  return parts.join('')
}

function dropComments(html: string): string {
  const parts: string[] = []
  let pos = 0
  for (;;) {
    const open = html.indexOf('<!--', pos)
    if (open < 0) break
    const close = html.indexOf('-->', open + 4)
    if (close < 0) break // unclosed: the rest stays, as before
    parts.push(html.slice(pos, open), ' ')
    pos = close + 3
  }
  parts.push(html.slice(pos))
  return parts.join('')
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'ul', 'ol', 'table', 'tr', 'blockquote', 'pre', 'dl', 'dt', 'dd', 'figure',
  'figcaption', 'address', 'details', 'summary', 'hr'])

/** What a tag becomes in the extracted text: headings "#" lines, blocks blank lines, list items "- ". */
function tagText(tag: string): string {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)
  if (!m) return ' '
  const closing = m[1] === '/'
  const name = m[2].toLowerCase()
  const heading = /^h([1-6])$/.exec(name)
  if (heading) return closing ? '\n\n' : `\n\n${'#'.repeat(Number(heading[1]))} `
  if (name === 'li') return closing ? ' ' : '\n- '
  if (name === 'br') return closing ? ' ' : '\n'
  if (BLOCK_TAGS.has(name)) return '\n\n'
  return ' '
}

export interface ExtractedPage {
  title: string
  text: string
  links: string[]
  canonical: string | null
  noindex: boolean
  nofollow: boolean
}

/**
 * Main readable text of an HTML page: scripts, styles, navigation, headers,
 * footers, asides and forms are dropped; <main> (or <article>) is preferred
 * over the whole body; headings become "#" lines and blocks become
 * paragraphs separated by blank lines, which the chunker splits on.
 */
export function extractHtml(html: string, pageUrl: string): ExtractedPage {
  let doc = dropComments(html.slice(0, HTML_EXTRACT_MAX_CHARS))
  for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas']) doc = dropElements(doc, tag)
  doc = closeTail(doc)

  let canonical: string | null = null
  let noindex = false
  let nofollow = false
  let baseHref = pageUrl
  for (const tag of doc.match(/<(?:link|meta|base)\b[^>]*>/gi) ?? []) {
    const a = attributes(tag)
    if (/^<base/i.test(tag) && a.href) baseHref = canonicalizeUrl(a.href, pageUrl) ?? baseHref
    else if (/^<link/i.test(tag) && a.rel?.toLowerCase().split(/\s+/).includes('canonical') && a.href) canonical = canonicalizeUrl(a.href, pageUrl)
    else if (/^<meta/i.test(tag) && /^(robots|bodhinoxbot)$/i.test(a.name ?? '')) {
      const directives = (a.content ?? '').toLowerCase()
      if (/\b(noindex|none)\b/.test(directives)) noindex = true
      if (/\b(nofollow|none)\b/.test(directives)) nofollow = true
    }
  }
  const inner = (el: ElementSpan | null) => (el ? doc.slice(el.innerStart, el.innerEnd) : '')
  const clean = (s: string) => decodeEntities(closeTail(s.slice(0, 4000)).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  const title = clean(inner(findElement(doc, 'title', 0))) || clean(inner(findElement(doc, 'h1', 0)))

  const links: string[] = []
  const seen = new Set<string>()
  if (!nofollow) {
    for (const tag of doc.match(/<a\b[^>]*>/gi) ?? []) {
      const a = attributes(tag)
      if (!a.href || /\bnofollow\b/i.test(a.rel ?? '')) continue
      const link = canonicalizeUrl(a.href, baseHref)
      if (link && !seen.has(link)) { seen.add(link); links.push(link) }
      if (links.length >= 1000) break
    }
  }

  const body = findElement(doc, 'body', 0, true)
  let main = body ? inner(body) : dropElements(doc, 'head')
  const mainEl = findElement(main, 'main', 0)
  const articles = mainEl ? [] : findElements(main, 'article')
  if (mainEl) main = main.slice(mainEl.innerStart, mainEl.innerEnd)
  else if (articles.length) main = articles.map((el) => main.slice(el.start, el.end)).join('\n')
  for (const tag of ['nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'dialog']) main = dropElements(main, tag)

  const text = decodeEntities(closeTail(main).replace(/<[^>]+>/g, tagText))
    .split('\n')
    .map((line) => line.replace(/[\t\f\v  ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n(- )?\n(?=- )/g, '\n')
    .replace(/^#+ *$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, PAGE_TEXT_MAX_CHARS)

  return { title: title.slice(0, 300), text, links, canonical, noindex, nofollow }
}

// ================================================================ charset

/** A WHATWG encoding label TextDecoder knows, else null. */
function knownEncoding(label: string | undefined): string | null {
  if (!label) return null
  try { return new TextDecoder(label.trim()).encoding } catch { return null }
}

/**
 * Decodes an HTML body the way a browser picks its encoding: a byte-order
 * mark, then the Content-Type charset, then a <meta charset> or http-equiv
 * declaration in the first 2 KB; UTF-8 when none is given or the label is
 * unknown. A meta declaration of UTF-16 means UTF-8 (the bytes were readable
 * as ASCII to find it).
 */
export function decodeHtml(body: Buffer, contentType: string): string {
  let encoding: string | null = null
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) encoding = 'utf-8'
  else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) encoding = 'utf-16le'
  else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) encoding = 'utf-16be'
  encoding ??= knownEncoding(/;\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1])
  if (!encoding) {
    const head = body.subarray(0, 2048).toString('latin1')
    const meta = /<meta\b[^>]{0,512}?charset\s*=\s*["']?\s*([-a-zA-Z0-9_:.]{1,40})/i.exec(head)
    encoding = knownEncoding(meta?.[1])
    if (encoding?.startsWith('utf-16')) encoding = 'utf-8'
  }
  try {
    return new TextDecoder(encoding ?? 'utf-8').decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

// ================================================================ crawl slices

export type CrawlErrorCode = 'invalid_url' | 'blocked' | 'robots_disallowed' | 'robots_unreachable'

export interface CrawlState {
  v: 1
  kind: 'website' | 'sitemap'
  site: string
  pending: string[]
  /** Short hashes of every URL ever queued. */
  seen: string[]
  /** Short hashes of page text already stored in this run. */
  contents: string[]
  sitemapQueue: string[]
  sitemapsRead: number
  robots: Record<string, RobotsRules>
  attempted: number
  /** Pages stored or confirmed unchanged; counts towards the page limit. */
  kept: number
  embedFailures: number
}

export type PageOutcome = 'stored' | 'unchanged' | 'embed_failed' | 'skipped'

export interface CrawlDeps {
  fetcher?: CrawlFetcher
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  delayMs?: number
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Starts a crawl of a website (follow links) or a sitemap (only the listed pages). */
export function initCrawl(kind: 'website' | 'sitemap', startUrl: string): { state: CrawlState } | { error: CrawlErrorCode } {
  const checked = checkCrawlUrl(startUrl)
  if (!checked.ok) return { error: checked.error }
  const start = canonicalizeUrl(startUrl)
  if (!start) return { error: 'invalid_url' }
  const site = crawlSite(new URL(start).hostname)
  return {
    state: {
      v: 1, kind, site,
      pending: kind === 'website' ? [start] : [],
      seen: [shortHash(start)],
      contents: [],
      sitemapQueue: kind === 'sitemap' ? [start] : [],
      sitemapsRead: 0,
      robots: {},
      attempted: 0, kept: 0, embedFailures: 0,
    },
  }
}

/** Validates a state read back from a job payload; anything malformed is rejected. */
export function parseCrawlState(value: unknown): CrawlState | null {
  const s = value as CrawlState | null
  if (!s || typeof s !== 'object' || s.v !== 1 || (s.kind !== 'website' && s.kind !== 'sitemap') || typeof s.site !== 'string') return null
  const strings = (a: unknown, max: number) => Array.isArray(a) && a.length <= max && a.every((x) => typeof x === 'string' && x.length <= 2048)
  if (!strings(s.pending, MAX_PENDING) || !strings(s.seen, 5000) || !strings(s.contents, 5000) || !strings(s.sitemapQueue, MAX_SITEMAPS * 2)) return null
  if (![s.sitemapsRead, s.attempted, s.kept, s.embedFailures].every((n) => Number.isInteger(n) && n >= 0)) return null
  if (!s.robots || typeof s.robots !== 'object' || Object.keys(s.robots).length > MAX_HOSTS) return null
  return s
}

function enqueue(state: CrawlState, url: string): void {
  if (state.pending.length >= MAX_PENDING || state.seen.length >= 5000) return
  if (!isSameSite(url, state.site) || !looksLikePage(url)) return
  const key = shortHash(url)
  if (state.seen.includes(key)) return
  state.seen.push(key)
  state.pending.push(url)
}

async function rulesFor(state: CrawlState, url: string, fetcher: CrawlFetcher): Promise<RobotsRules | null> {
  const origin = new URL(url).origin
  if (state.robots[origin]) return state.robots[origin]
  if (Object.keys(state.robots).length >= MAX_HOSTS) return null
  const loaded = await loadRobots(origin, fetcher)
  const rules: RobotsRules = { allow: loaded.allow, disallow: loaded.disallow, crawlDelayMs: loaded.crawlDelayMs }
  state.robots[origin] = rules
  return rules
}

async function allowed(state: CrawlState, url: string, fetcher: CrawlFetcher): Promise<boolean> {
  if (!isSameSite(url, state.site)) return false
  const rules = await rulesFor(state, url, fetcher)
  if (!rules) return false
  const u = new URL(url)
  return isAllowedByRobots(rules, `${u.pathname}${u.search}`)
}

/** GET with up to three redirects, each hop kept on the site and allowed by robots.txt. */
async function fetchAllowed(state: CrawlState, url: string, fetcher: CrawlFetcher, maxBytes: number, accept: string):
  Promise<{ url: string; res: Extract<CrawlFetchResult, { ok: true }> } | null> {
  let target = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await allowed(state, target, fetcher))) return null
    const res = await fetcher(target, { maxBytes, accept })
    if (!res.ok) return null
    if (res.status >= 300 && res.status < 400) {
      const next = res.location ? canonicalizeUrl(res.location, target) : null
      if (!next) return null
      target = next
      continue
    }
    return res.status >= 200 && res.status < 300 ? { url: target, res } : null
  }
  return null
}

async function readSitemap(state: CrawlState, url: string, fetcher: CrawlFetcher): Promise<void> {
  state.sitemapsRead += 1
  const got = await fetchAllowed(state, url, fetcher, SITEMAP_MAX_BYTES, 'application/xml,text/xml;q=0.9,*/*;q=0.5')
  if (!got) return
  const xml = bodyText(got.res.body, got.url, got.res.contentType)
  if (!xml) return
  const { urls, sitemaps } = parseSitemap(xml)
  for (const child of sitemaps) {
    const c = canonicalizeUrl(child, got.url)
    if (c && isSameSite(c, state.site) && state.sitemapQueue.length + state.sitemapsRead < MAX_SITEMAPS && !state.sitemapQueue.includes(c)) state.sitemapQueue.push(c)
  }
  for (const page of urls) {
    const c = canonicalizeUrl(page, got.url)
    if (c) enqueue(state, c)
  }
}

export interface PageForIndex { url: string; title: string; text: string; hash: string }

/**
 * Runs one time-boxed slice of a crawl. `onPage` stores a page and says what
 * happened to it. Returns done=true when nothing is left or the page limit is
 * reached; the caller persists `state` and schedules the next slice otherwise.
 */
export async function runCrawlSlice(state: CrawlState, opts: {
  pageLimit: number
  budgetMs: number
  onPage: (page: PageForIndex) => Promise<PageOutcome>
} & CrawlDeps): Promise<{ done: boolean }> {
  const fetcher = opts.fetcher ?? defaultFetcher
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? Date.now
  const deadline = now() + opts.budgetMs
  const maxAttempts = opts.pageLimit * 3

  const finished = () => state.kept >= opts.pageLimit || state.attempted >= maxAttempts
    || (state.pending.length === 0 && state.sitemapQueue.length === 0)

  while (!finished() && now() < deadline) {
    if (state.pending.length < opts.pageLimit && state.sitemapQueue.length > 0) {
      if (state.sitemapsRead >= MAX_SITEMAPS) state.sitemapQueue = []
      else await readSitemap(state, state.sitemapQueue.shift() as string, fetcher)
      continue
    }
    const room = Math.max(1, Math.min(CRAWL_CONCURRENCY, opts.pageLimit - state.kept))
    const batch = state.pending.splice(0, room)
    state.attempted += batch.length
    await Promise.all(batch.map((url) => crawlPage(state, url, fetcher, opts.onPage)))
    const delay = Math.max(opts.delayMs ?? CRAWL_DELAY_MS, ...Object.values(state.robots).map((r) => r.crawlDelayMs))
    if (!finished() && now() + delay < deadline) await sleep(delay)
  }
  return { done: finished() }
}

async function crawlPage(state: CrawlState, url: string, fetcher: CrawlFetcher,
  onPage: (page: PageForIndex) => Promise<PageOutcome>): Promise<void> {
  const got = await fetchAllowed(state, url, fetcher, PAGE_MAX_BYTES, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1')
  if (!got) return
  const finalUrl = canonicalizeUrl(got.url) ?? url
  if (finalUrl !== url) {
    const key = shortHash(finalUrl)
    if (state.seen.includes(key)) return
    state.seen.push(key)
  }
  if (!/text\/html|application\/xhtml\+xml/.test(got.res.contentType)) return
  const page = extractHtml(decodeHtml(got.res.body, got.res.contentType), finalUrl)
  if (state.kind === 'website') for (const link of page.links) enqueue(state, link)
  if (page.noindex) return

  // A canonical link on the same site names the page's real address.
  let docUrl = finalUrl
  if (page.canonical && page.canonical !== finalUrl && isSameSite(page.canonical, state.site)) {
    const key = shortHash(page.canonical)
    if (state.seen.includes(key)) return // crawled already, or queued to be crawled itself
    state.seen.push(key)
    docUrl = page.canonical
  }
  if (page.text.length < MIN_PAGE_TEXT_CHARS) return
  const hash = contentHash(page.text)
  const short = hash.slice(0, 16)
  if (state.contents.includes(short)) return // the same text under another address
  state.contents.push(short)
  const title = page.title || new URL(docUrl).pathname
  const outcome = await onPage({ url: docUrl, title, text: page.text, hash })
  if (outcome === 'skipped') return
  state.kept += 1
  if (outcome === 'embed_failed') state.embedFailures += 1
}
