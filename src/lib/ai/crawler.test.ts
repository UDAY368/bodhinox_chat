import { describe, expect, it, vi } from 'vitest'
import {
  canonicalizeUrl, checkCrawlUrl, crawlFetch, crawlSite, decodeHtml, extractHtml, initCrawl, isAllowedByRobots, isSameSite,
  loadRobots, parseCrawlState, parseRobots, parseSitemap, patternMatches, runCrawlSlice, ROBOTS_MAX_BYTES,
  type CrawlFetcher, type CrawlState, type PageForIndex, type PageOutcome,
} from './crawler'

type Page = { status?: number; type?: string; body?: string | Buffer; location?: string }
function fakeSite(pages: Record<string, Page>) {
  const calls: string[] = []
  const fetcher: CrawlFetcher = async (url) => {
    calls.push(url)
    const page = pages[url]
    if (!page) return { ok: true, status: 404, contentType: 'text/html', location: null, body: Buffer.from('') }
    return {
      ok: true, status: page.status ?? 200, contentType: page.type ?? 'text/html; charset=utf-8',
      location: page.location ?? null, body: Buffer.isBuffer(page.body) ? page.body : Buffer.from(page.body ?? ''),
    }
  }
  return { fetcher, calls }
}
const html = (title: string, body: string, head = '') =>
  `<html><head><title>${title}</title>${head}</head><body><nav><a href="/nav">Nav link</a></nav><main>${body}</main><footer>Footer text</footer></body></html>`
const para = (s: string) => `<p>${s} — this paragraph has enough words to count as real page content.</p>`

async function crawl(state: CrawlState, fetcher: CrawlFetcher, pageLimit = 50, onPage?: (p: PageForIndex) => Promise<PageOutcome>) {
  const pages: PageForIndex[] = []
  let t = 0
  let done = false
  for (let i = 0; i < 20 && !done; i++) {
    ({ done } = await runCrawlSlice(state, {
      pageLimit, budgetMs: 60_000, fetcher, delayMs: 0, sleep: async () => {}, now: () => (t += 1),
      onPage: onPage ?? (async (p) => { pages.push(p); return 'stored' }),
    }))
  }
  return { pages, done }
}
const start = (kind: 'website' | 'sitemap', url: string) => {
  const init = initCrawl(kind, url)
  if ('error' in init) throw new Error(init.error)
  return init.state
}

describe('robots.txt', () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.json$
Crawl-delay: 2

User-agent: OtherBot
Disallow: /

Sitemap: https://example.com/sitemap.xml`)

  it('uses the * group, longest match wins and Allow wins a tie', () => {
    expect(isAllowedByRobots(robots, '/')).toBe(true)
    expect(isAllowedByRobots(robots, '/private/x')).toBe(false)
    expect(isAllowedByRobots(robots, '/private/public/page')).toBe(true)
    expect(isAllowedByRobots(robots, '/data.json')).toBe(false)
    expect(isAllowedByRobots(robots, '/data.json?x=1')).toBe(true)
    expect(isAllowedByRobots({ allow: ['/a'], disallow: ['/a'], crawlDelayMs: 0 }, '/a')).toBe(true)
    expect(robots.crawlDelayMs).toBe(2000)
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml'])
  })

  it('prefers a group naming BodhinoxBot over *', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: BodhinoxBot\nUser-agent: other\nDisallow: /admin\n')
    expect(isAllowedByRobots(rules, '/pricing')).toBe(true)
    expect(isAllowedByRobots(rules, '/admin/x')).toBe(false)
  })

  it('treats an empty Disallow as allow-all and caps the delay', () => {
    const rules = parseRobots('User-agent: *\nDisallow:\nCrawl-delay: 120')
    expect(isAllowedByRobots(rules, '/anything')).toBe(true)
    expect(rules.crawlDelayMs).toBe(5000)
  })

  it('matches wildcards and $ exactly', () => {
    expect(patternMatches('/a*b$', '/axxb')).toBe(true)
    expect(patternMatches('/a*b$', '/axxbc')).toBe(false)
    expect(patternMatches('/a*b', '/axxbc')).toBe(true)
    expect(patternMatches('/*.php$', '/x.php.php')).toBe(true)
    expect(patternMatches('/*ab*ab$', '/abab')).toBe(true)
    expect(patternMatches('/*ab*ab$', '/ab')).toBe(false)
    expect(patternMatches('/x$', '/x')).toBe(true)
    expect(patternMatches('/x$', '/xy')).toBe(false)
    expect(patternMatches('*', '/anything')).toBe(true)
    expect(patternMatches('/a.b', '/aXb')).toBe(false)
  })

  it('evaluates a hostile wildcard pattern in linear time', () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /${'*a'.repeat(40)}*b\nAllow: /${'*a'.repeat(200)}`)
    const path = `/${'a'.repeat(510)}`
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) isAllowedByRobots(rules, path)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(patternMatches(`/${'*a'.repeat(6)}*b`, `/${'a'.repeat(500)}`)).toBe(false)
    expect(patternMatches(`/${'*a'.repeat(6)}*b`, `/${'a'.repeat(500)}b`)).toBe(true)
  })

  it('drops over-long rules and collapses repeated stars', () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /${'x'.repeat(600)}\nDisallow: /p***q`)
    expect(rules.disallow).toEqual(['/p*q'])
  })

  it('parses the first part of an over-cap robots.txt instead of ignoring it', async () => {
    const big = `User-agent: *\nDisallow: /\n${'# filler line\n'.repeat(Math.ceil(ROBOTS_MAX_BYTES / 14) + 10)}Allow: /`
    let seenOpts: { truncate?: boolean } = {}
    const fetcher: CrawlFetcher = async (_url, opts) => {
      seenOpts = opts
      const body = Buffer.from(big)
      return { ok: true, status: 200, contentType: 'text/plain', location: null, body: body.subarray(0, opts.maxBytes), truncated: true }
    }
    const rules = await loadRobots('https://a.com', fetcher)
    expect(seenOpts.truncate).toBe(true)
    expect(rules.disallow).toEqual(['/'])
    expect(rules.allow).toEqual([])
    expect(isAllowedByRobots(rules, '/x')).toBe(false)
    // A fetcher that cannot return any of it: unreachable, so disallow all.
    const tooLarge: CrawlFetcher = async () => ({ ok: false, error: 'too_large' })
    expect(isAllowedByRobots(await loadRobots('https://a.com', tooLarge), '/x')).toBe(false)
  })

  it('drops a final line cut mid-rule', async () => {
    const fetcher: CrawlFetcher = async () => ({
      ok: true, status: 200, contentType: 'text/plain', location: null, truncated: true,
      body: Buffer.from('User-agent: *\nDisallow: /private\nDisallow: /'),
    })
    expect((await loadRobots('https://a.com', fetcher)).disallow).toEqual(['/private'])
  })

  it('allows all on 404 and disallows all when robots.txt is unreachable', async () => {
    expect(isAllowedByRobots(await loadRobots('https://a.com', fakeSite({}).fetcher), '/x')).toBe(true)
    const down = fakeSite({ 'https://a.com/robots.txt': { status: 503 } })
    expect(isAllowedByRobots(await loadRobots('https://a.com', down.fetcher), '/x')).toBe(false)
    const failing: CrawlFetcher = async () => ({ ok: false, error: 'network' })
    expect(isAllowedByRobots(await loadRobots('https://a.com', failing), '/x')).toBe(false)
  })
})

describe('sites and URLs', () => {
  it('scopes the crawl to the exact host and its www./apex twin', () => {
    expect(crawlSite('Shop.Example.com.')).toBe('shop.example.com')
    expect(isSameSite('https://example.com/a', 'example.com')).toBe(true)
    expect(isSameSite('https://www.example.com/a', 'example.com')).toBe(true)
    expect(isSameSite('https://example.com/a', 'www.example.com')).toBe(true)
    expect(isSameSite('https://docs.example.com/a', 'example.com')).toBe(false)
    expect(isSameSite('https://example.org/a', 'example.com')).toBe(false)
    expect(isSameSite('https://www.www.example.com/', 'example.com')).toBe(false)
    expect(isSameSite('https://bob.github.io/', 'alice.github.io')).toBe(false)
  })

  it.each([
    ['https://shop.up.railway.app/', 'https://other.up.railway.app/'],
    ['https://a.fly.dev/', 'https://b.fly.dev/'],
    ['https://x.s3.amazonaws.com/', 'https://y.s3.amazonaws.com/'],
    ['https://x.appspot.com/', 'https://evil.appspot.com/'],
  ])('never leaves %s for another tenant on the same platform (%s)', async (home, other) => {
    const state = start('website', home)
    expect(isSameSite(other, state.site)).toBe(false)
    const s = fakeSite({
      [home]: { body: html('Home', para('Home') + `<a href="${other}">x</a>`) },
      [other]: { body: html('Other', para('Other tenant')) },
    })
    const { pages } = await crawl(state, s.fetcher)
    expect(pages.map((p) => p.url)).toEqual([home])
    expect(s.calls.some((u) => u.startsWith(other))).toBe(false)
  })

  it('canonicalizes URLs', () => {
    expect(canonicalizeUrl('/a?utm_source=x&id=2#top', 'https://Example.com/b')).toBe('https://example.com/a?id=2')
    expect(canonicalizeUrl('https://example.com:443/x?utm_medium=y')).toBe('https://example.com/x')
    expect(canonicalizeUrl('mailto:a@b.com')).toBeNull()
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull()
    expect(canonicalizeUrl('https://user:pw@example.com/')).toBeNull()
  })
})

describe('SSRF refusal', () => {
  it.each([
    'http://127.0.0.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/',
    'http://localhost/', 'http://db.internal/', 'http://printer.local/', 'http://intranet/', 'https://example.com:8443/',
  ])('blocks %s before connecting', async (url) => {
    expect(checkCrawlUrl(url)).toEqual({ ok: false, error: 'blocked' })
    expect(await crawlFetch(url, { maxBytes: 1024, accept: '*/*' })).toEqual({ ok: false, error: 'blocked' })
  })

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'https://a:b@example.com/', 'not a url'])('rejects %s', async (url) => {
    expect(await crawlFetch(url, { maxBytes: 1024, accept: '*/*' })).toEqual({ ok: false, error: 'invalid_url' })
  })

  it('refuses to start a crawl on a private address', () => {
    expect(initCrawl('website', 'http://192.168.1.1/')).toEqual({ error: 'blocked' })
  })

  it('does not follow a redirect off the site', async () => {
    const site = fakeSite({
      'https://example.com/': { status: 301, location: 'https://evil.test/steal' },
    })
    const { pages } = await crawl(start('website', 'https://example.com/'), site.fetcher)
    expect(pages).toEqual([])
    expect(site.calls).not.toContain('https://evil.test/steal')
  })
})

describe('sitemaps', () => {
  it('parses url sets and sitemap indexes', () => {
    expect(parseSitemap('<urlset><url><loc> https://a.com/x?a=1&amp;b=2 </loc></url><url><loc><![CDATA[https://a.com/y]]></loc></url></urlset>'))
      .toEqual({ urls: ['https://a.com/x?a=1&b=2', 'https://a.com/y'], sitemaps: [] })
    expect(parseSitemap('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>'))
      .toEqual({ urls: [], sitemaps: ['https://a.com/s1.xml'] })
  })

  it('parses an unclosed <loc> flood in linear time', () => {
    const xml = '<urlset>' + '<loc>'.repeat(200_000) + ' '.repeat(100_000)
    const t0 = performance.now()
    expect(parseSitemap(xml)).toEqual({ urls: [], sitemaps: [] })
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('crawls only the listed same-site pages, through an index', async () => {
    const site = fakeSite({
      'https://a.com/sitemap.xml': { type: 'application/xml', body: '<sitemapindex><sitemap><loc>https://a.com/pages.xml</loc></sitemap><sitemap><loc>https://other.com/s.xml</loc></sitemap></sitemapindex>' },
      'https://a.com/pages.xml': { type: 'application/xml', body: '<urlset><url><loc>https://a.com/one</loc></url><url><loc>https://other.com/x</loc></url><url><loc>https://a.com/two</loc></url></urlset>' },
      'https://a.com/one': { body: html('One', para('First') + '<a href="/three">three</a>') },
      'https://a.com/two': { body: html('Two', para('Second')) },
      'https://a.com/three': { body: html('Three', para('Third')) },
    })
    const { pages, done } = await crawl(start('sitemap', 'https://a.com/sitemap.xml'), site.fetcher)
    expect(done).toBe(true)
    expect(pages.map((p) => p.url).sort()).toEqual(['https://a.com/one', 'https://a.com/two'])
    expect(site.calls.some((u) => u.includes('other.com'))).toBe(false)
  })
})

describe('website crawl', () => {
  const home = html('Home', para('Welcome') + '<a href="/about">About</a> <a href="/cart">Cart</a> <a href="https://blog.shop.com/post">Blog</a> <a href="https://elsewhere.com/">Out</a> <a href="/file.pdf">pdf</a> <a href="/dup?utm_source=a">dup</a>')
  const site = () => fakeSite({
    'https://www.shop.com/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /cart' },
    'https://www.shop.com/': { body: home },
    'https://www.shop.com/about': { body: html('About', para('About us')) },
    'https://www.shop.com/dup': { body: home },
    'https://blog.shop.com/post': { body: html('Post', para('A post')) },
    'https://www.shop.com/cart': { body: html('Cart', para('Cart')) },
  })

  it('follows same-site links, respects robots and dedupes content', async () => {
    const s = site()
    const { pages } = await crawl(start('website', 'https://www.shop.com/'), s.fetcher)
    expect(pages.map((p) => p.url).sort()).toEqual(['https://www.shop.com/', 'https://www.shop.com/about'])
    expect(s.calls).not.toContain('https://blog.shop.com/post')
    expect(s.calls).not.toContain('https://www.shop.com/cart')
    expect(s.calls).not.toContain('https://elsewhere.com/')
    expect(s.calls).not.toContain('https://www.shop.com/file.pdf')
    expect(pages[0].hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stops at the page limit', async () => {
    const { pages } = await crawl(start('website', 'https://www.shop.com/'), site().fetcher, 1)
    expect(pages).toHaveLength(1)
  })

  it('counts unchanged pages towards the limit without storing them again', async () => {
    const onPage = vi.fn(async (): Promise<PageOutcome> => 'unchanged')
    const state = start('website', 'https://www.shop.com/')
    await crawl(state, site().fetcher, 50, onPage)
    expect(onPage).toHaveBeenCalledTimes(2)
    expect(state.kept).toBe(2)
  })

  it('keeps a page under its same-site canonical address and skips noindex pages', async () => {
    const s = fakeSite({
      'https://a.com/': { body: html('Home', para('Home') + '<a href="/p?id=1">p</a><a href="/hidden">h</a>') },
      'https://a.com/p?id=1': { body: html('P', para('Product'), '<link rel="canonical" href="https://a.com/product">') },
      'https://a.com/hidden': { body: html('Hidden', para('Secret'), '<meta name="robots" content="noindex">') },
    })
    const { pages } = await crawl(start('website', 'https://a.com/'), s.fetcher)
    expect(pages.map((p) => p.url).sort()).toEqual(['https://a.com/', 'https://a.com/product'])
  })

  it('round-trips its state through JSON for the next slice', async () => {
    const state = start('website', 'https://www.shop.com/')
    const restored = parseCrawlState(JSON.parse(JSON.stringify(state)))
    expect(restored).toEqual(state)
    expect(parseCrawlState({ ...state, v: 2 })).toBeNull()
    expect(parseCrawlState({ ...state, pending: 'x' })).toBeNull()
  })
})

describe('HTML extraction', () => {
  it('keeps headings and main text, drops chrome and scripts', () => {
    const page = extractHtml(`<html><head><title>Pricing &amp; Plans</title><style>.x{}</style></head><body>
      <header>Site header</header><nav><a href="/a">A</a></nav>
      <main><h1>Plans</h1><p>Basic costs &#8377;99 per month.</p><script>alert('x')</script>
      <ul><li>One</li><li>Two</li></ul><h2>FAQ</h2><p>Ask us anything.</p><form>Email <input></form></main>
      <footer>Copyright</footer></body></html>`, 'https://a.com/pricing')
    expect(page.title).toBe('Pricing & Plans')
    expect(page.text).toContain('# Plans')
    expect(page.text).toContain('## FAQ')
    expect(page.text).toContain('Basic costs ₹99 per month.')
    expect(page.text).toContain('- One\n- Two')
    for (const gone of ['Site header', 'Copyright', 'alert', 'Email', '.x{}']) expect(page.text).not.toContain(gone)
    expect(page.links).toEqual(['https://a.com/a'])
    expect(page.text.split(/\n\s*\n/).length).toBeGreaterThan(2)
  })

  it.each([
    ['unclosed <title>', '<title></titl '.repeat(150_000)],
    ['unclosed <main>', '<body><main '.repeat(150_000)],
    ['unclosed <article>', '<body><article>x'.repeat(120_000)],
    ['unclosed <script>', '<script>x'.repeat(200_000)],
    ['unclosed comments', '<!--x'.repeat(300_000)],
    ['tags without >', '<a href=x <meta '.repeat(120_000)],
    ['orphaned < after drops', '<b <li><a <script>x</script>'.repeat(60_000)],
    ['long attribute run', `<html><body><a ${'x'.repeat(4000)}>y</a>`.repeat(200)],
    ['unclosed body', '<body>'.repeat(200_000)],
  ])('extracts a hostile page (%s) in linear time', (_name, page) => {
    const t0 = performance.now()
    const out = extractHtml(page, 'https://a.com/')
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(typeof out.text).toBe('string')
  })

  it('still extracts a normal page after the linear rewrite', () => {
    const page = extractHtml('<!doctype html><html><head><title>T</title><!-- c --></head><BODY><Main class="m"><H2>Sub</H2><p>One &lt; two</p>'
      + '<article>A</article><br/>Line</Main><main>second</main></BODY></html> trailing < text', 'https://a.com/')
    expect(page.title).toBe('T')
    expect(page.text).toBe('## Sub\n\nOne < two\n\nA\nLine')
  })

  it('joins articles when there is no <main>', () => {
    const page = extractHtml('<body><nav>n</nav><article><p>First</p></article><div>x</div><article>Second</article></body>', 'https://a.com/')
    expect(page.text).toBe('First\n\nSecond')
  })

  it('falls back to the body and honours nofollow', () => {
    const page = extractHtml('<body><meta name="robots" content="nofollow"><div>Plain body text</div><a href="/x">x</a></body>', 'https://a.com/')
    expect(page.text).toContain('Plain body text')
    expect(page.links).toEqual([])
    expect(page.nofollow).toBe(true)
  })
})

describe('charset decoding', () => {
  const cafe1252 = Buffer.concat([Buffer.from('<html><head></head><body><p>Caf'), Buffer.from([0xe9, 0x20, 0x80]), Buffer.from('</p></body></html>')])

  it('honours the Content-Type charset', () => {
    expect(decodeHtml(cafe1252, 'text/html; charset=windows-1252')).toContain('Caf\u00e9 \u20ac')
    expect(decodeHtml(cafe1252, 'text/html; charset="iso-8859-1"')).toContain('Caf\u00e9 \u20ac')
  })

  it('honours <meta charset> and http-equiv when the header has none', () => {
    const meta = Buffer.concat([Buffer.from('<meta charset="windows-1252">'), cafe1252])
    expect(decodeHtml(meta, 'text/html')).toContain('Caf\u00e9 \u20ac')
    const equiv = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'), cafe1252])
    expect(decodeHtml(equiv, 'text/html')).toContain('Caf\u00e9')
    const sjis = Buffer.concat([Buffer.from('<meta charset=shift_jis><p>'), Buffer.from([0x93, 0xfa, 0x96, 0x7b])])
    expect(decodeHtml(sjis, 'text/html')).toContain('\u65e5\u672c')
  })

  it('prefers a BOM, then the header, then meta, and falls back to UTF-8 for unknown labels', () => {
    const utf8 = Buffer.from('<meta charset="windows-1252"><p>Caf\u00e9 \u20b9</p>')
    expect(decodeHtml(utf8, 'text/html; charset=utf-8')).toContain('Caf\u00e9 \u20b9')
    expect(decodeHtml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]), 'text/html; charset=windows-1252')).toContain('Caf\u00e9 \u20b9')
    expect(decodeHtml(Buffer.from('<p>Caf\u00e9</p>'), 'text/html; charset=no-such-charset')).toContain('Caf\u00e9')
    expect(decodeHtml(Buffer.from('<meta charset="utf-16"><p>Caf\u00e9</p>'), 'text/html')).toContain('Caf\u00e9')
    expect(decodeHtml(Buffer.from('<p>Caf\u00e9</p>'), '')).toContain('Caf\u00e9')
  })

  it('stores correctly decoded text from a windows-1252 site', async () => {
    const page = (charsetInHeader: boolean) => Buffer.concat([
      Buffer.from(`<html><head><title>Menu</title>${charsetInHeader ? '' : '<meta charset="windows-1252">'}</head><body><main><p>Our caf`),
      Buffer.from([0xe9]), Buffer.from(' serves coffee and tea every day of the week.</p></main></body></html>'),
    ])
    for (const inHeader of [true, false]) {
      const s = fakeSite({ 'https://a.com/': { type: inHeader ? 'text/html; charset=windows-1252' : 'text/html', body: page(inHeader) } })
      const { pages } = await crawl(start('website', 'https://a.com/'), s.fetcher)
      expect(pages[0].text).toContain('Our caf\u00e9 serves')
    }
  })
})
