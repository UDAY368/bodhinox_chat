import { describe, expect, it } from 'vitest';
import {
  cleanShopPath, isPageKey, likeContains, likePrefix, LIVE_TOP_PAGES, LIVE_WINDOW_MINUTES, minuteBucket, pageKeyOf, redirectIssue, REDIRECT_LIMIT,
  resolveRedirectChain, searchTerms, SEARCH_MAX_LENGTH, summarizeLive, type RedirectRule,
} from './shop-insights-rules';

const ID = '3f2b8c1e-9d4a-4e6b-8a1c-0d5e7f9a2b34';
const rule = (from: string, to: string, code: 301 | 302 = 301): RedirectRule => ({ from, to, code });

describe('live view page keys', () => {
  it('maps shop paths to a fixed key set', () => {
    expect(pageKeyOf('/')).toBe('home');
    expect(pageKeyOf('')).toBe('home');
    expect(pageKeyOf('/all')).toBe('all');
    expect(pageKeyOf('/cart/')).toBe('cart');
    expect(pageKeyOf('/search?q=oil')).toBe('search');
    expect(pageKeyOf(`/p/${ID}`)).toBe(`product:${ID}`);
    expect(pageKeyOf(`/p/${ID.toUpperCase()}`)).toBe(`product:${ID}`);
    expect(pageKeyOf(`/c/${ID}`)).toBe(`category:${ID}`);
    expect(pageKeyOf('/pages/shipping')).toBe('page:shipping');
  });

  it('folds anything else into "other", so a caller cannot widen the key set', () => {
    for (const bad of ['/p/not-a-uuid', '/p/' + ID + '/extra', '/pages/Bad Slug', '/pages/../x', '/zzz', 5, null, undefined, { a: 1 }, 'x'.repeat(300)]) {
      expect(pageKeyOf(bad)).toBe('other');
    }
  });

  it('only produces keys the database accepts', () => {
    for (const p of ['/', '/all', '/search', '/cart', '/links', `/p/${ID}`, `/c/${ID}`, '/pages/faq', '/nothing']) expect(isPageKey(pageKeyOf(p))).toBe(true);
    expect(isPageKey('product:<script>')).toBe(false);
    expect(isPageKey('visitor:1.2.3.4')).toBe(false);
  });
});

describe('live view bucketing', () => {
  const now = new Date('2026-11-20T10:07:30Z');
  const at = (minutesAgo: number) => minuteBucket(new Date(Date.parse('2026-11-20T10:07:00Z') - minutesAgo * 60_000));

  it('cuts a time to its minute', () => {
    expect(minuteBucket(now)).toBe('2026-11-20T10:07:00.000Z');
  });

  it('sums the last five minutes, oldest first, and ignores older or future rows', () => {
    const summary = summarizeLive([
      { minute: at(0), page: 'home', hits: 2 }, { minute: at(0), page: `product:${ID}`, hits: 3 }, { minute: at(1), page: 'home', hits: 4 },
      { minute: at(4), page: 'cart', hits: 1 }, { minute: at(5), page: 'home', hits: 99 }, { minute: at(-1), page: 'home', hits: 50 },
    ], now);
    expect(summary.perMinute).toEqual([1, 0, 0, 4, 5]);
    expect(summary.pages).toEqual([{ page: 'home', hits: 6 }, { page: `product:${ID}`, hits: 3 }, { page: 'cart', hits: 1 }]);
    expect(summary.perMinute).toHaveLength(LIVE_WINDOW_MINUTES);
  });

  it('counts visitors now as the larger of the last two minutes (each open tab reports once a minute)', () => {
    expect(summarizeLive([{ minute: at(1), page: 'home', hits: 7 }, { minute: at(0), page: 'home', hits: 3 }], now).active).toBe(7);
    expect(summarizeLive([{ minute: at(1), page: 'home', hits: 2 }, { minute: at(0), page: 'home', hits: 5 }], now).active).toBe(5);
    expect(summarizeLive([], now)).toEqual({ active: 0, perMinute: [0, 0, 0, 0, 0], pages: [] });
  });

  it('lists a bounded number of pages', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ minute: at(0), page: `page:p${i}`, hits: i + 1 }));
    const pages = summarizeLive(rows, now).pages;
    expect(pages).toHaveLength(LIVE_TOP_PAGES);
    expect(pages[0].hits).toBe(20);
  });

  it('ignores malformed rows', () => {
    expect(summarizeLive([{ minute: 'nope', page: 'home', hits: 5 }, { minute: at(0), page: 'home', hits: -3 }, { minute: at(0), page: 'home', hits: Number.NaN }], now).active).toBe(0);
  });
});

describe('search query cleaning', () => {
  it('needs two characters and keeps at most four words of sixty characters', () => {
    expect(searchTerms('a')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
    expect(searchTerms(5)).toEqual([]);
    expect(searchTerms('  rose   oil ')).toEqual(['rose', 'oil']);
    expect(searchTerms('one two three four five six')).toEqual(['one', 'two', 'three', 'four']);
    expect(searchTerms('x'.repeat(200)).join('').length).toBe(SEARCH_MAX_LENGTH);
  });

  it('drops control characters', () => {
    expect(searchTerms('ro\u0000se\n\toil')).toEqual(['ro', 'se', 'oil']);
  });

  it('escapes LIKE wildcards so a typed % or _ matches itself', () => {
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(likePrefix('a%')).toBe('a\\%%');
    expect(likeContains("o'brien; DROP TABLE x")).toBe("%o'brien; DROP TABLE x%");
  });
});

describe('redirect paths', () => {
  it('accepts a path inside the shop, with or without the shop prefix', () => {
    expect(cleanShopPath('/old-oil', 'kumar')).toBe('/old-oil');
    expect(cleanShopPath('/s/kumar/old-oil/', 'kumar')).toBe('/old-oil');
    expect(cleanShopPath('/s/kumar', 'kumar')).toBe('/');
    expect(cleanShopPath(`/p/${ID}`, 'kumar')).toBe(`/p/${ID}`);
    expect(cleanShopPath(' /a_b.c~d/e%20f ', 'kumar')).toBe('/a_b.c~d/e%20f');
  });

  it('refuses another host, a scheme, a protocol-relative address and traversal (no open redirect)', () => {
    for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'evil.example/x', 'javascript:alert(1)', '/a//b', '/../x', '/a/../b',
      '/a?x=1', '/a#b', '', '   ', 'old-oil', '/a b', '/<script>', null, 7, '/' + 'a'.repeat(250)]) {
      expect(cleanShopPath(bad, 'kumar')).toBeNull();
    }
    // Another shop's prefix is just a path inside this one, never a jump to that shop's host.
    expect(cleanShopPath('/s/other/x', 'kumar')).toBe('/s/other/x');
  });
});

describe('redirect rules', () => {
  it('follows a chain to its end and keeps it permanent only when every hop is', () => {
    const rules = [rule('/a', '/b'), rule('/b', '/c', 302), rule('/c', '/d')];
    expect(resolveRedirectChain(rules, '/a')).toEqual({ to: '/d', code: 302 });
    expect(resolveRedirectChain(rules, '/c')).toEqual({ to: '/d', code: 301 });
    expect(resolveRedirectChain(rules, '/zzz')).toBeNull();
  });

  it('gives up on a loop or a chain longer than five hops', () => {
    expect(resolveRedirectChain([rule('/a', '/b'), rule('/b', '/a')], '/a')).toBeNull();
    expect(resolveRedirectChain([rule('/1', '/2'), rule('/2', '/3'), rule('/3', '/4'), rule('/4', '/5'), rule('/5', '/6'), rule('/6', '/7')], '/1')).toBeNull();
    expect(resolveRedirectChain([rule('/1', '/2'), rule('/2', '/3'), rule('/3', '/4'), rule('/4', '/5'), rule('/5', '/6')], '/1')).toEqual({ to: '/6', code: 301 });
  });

  it('refuses a rule that closes a loop, repeats a source, points at itself or breaks the cap', () => {
    const existing = [rule('/a', '/b'), rule('/b', '/c')];
    expect(redirectIssue(rule('/c', '/a'), existing)).toBe('loop');
    expect(redirectIssue(rule('/c', '/d'), existing)).toBeNull();
    expect(redirectIssue(rule('/x', '/x'), existing)).toBe('same');
    expect(redirectIssue(rule('/a', '/z'), existing)).toBe('duplicate');
    expect(redirectIssue(rule('/', '/z'), existing)).toBe('invalid_from');
    const full = Array.from({ length: REDIRECT_LIMIT }, (_, i) => rule(`/old${i}`, `/new${i}`));
    expect(redirectIssue(rule('/one-more', '/target'), full)).toBe('limit');
  });

  it('refuses a rule that would make a chain too long to follow', () => {
    const existing = [rule('/1', '/2'), rule('/2', '/3'), rule('/3', '/4'), rule('/4', '/5'), rule('/5', '/6')];
    expect(redirectIssue(rule('/6', '/7'), existing)).toBe('loop');
  });
});
