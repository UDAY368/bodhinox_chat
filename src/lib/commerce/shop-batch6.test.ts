import { describe, expect, it } from 'vitest';
import { timeLeft } from '@/components/shop-public/offer-countdown';
import { PRODUCT_LAYOUT_CLASSES } from '@/components/shop-public/product-layout';
import { newSection, parseMoment, parseSection, SECTION_SPECS, SHOP_SECTION_TYPES, TRUST_ICONS } from './shop-sections';
import { parseProductIds, RECENT_IDS_MAX } from './shop-recently-viewed';
import {
  contrastRatio, parseThemeSettings, readableOn, resolveTheme, SHOP_FONT_IDS, SHOP_FONTS, SHOP_TEMPLATE_IDS, SHOP_TEMPLATES, ShopThemeError, themeCssVars,
} from './shop-templates';

const M = 'media:0b8c3c3e-8a5e-4d6c-9a52-0f6f2b1d2e3f';
const U = (n: number) => `0b8c3c3e-8a5e-4d6c-9a52-${String(n).padStart(12, '0')}`;

describe('templates that really differ (batch 6)', () => {
  it('gives every template its own header, card, product page and footer combination', () => {
    const combos = SHOP_TEMPLATE_IDS.map((id) => {
      const l = SHOP_TEMPLATES[id].layout;
      return `${l.header}/${l.card}/${l.product}/${l.footer}`;
    });
    expect(new Set(combos).size).toBe(SHOP_TEMPLATE_IDS.length);
    // Every variant is used by at least one template.
    const used = (key: 'header' | 'card' | 'product' | 'footer') => new Set(SHOP_TEMPLATE_IDS.map((id) => SHOP_TEMPLATES[id].layout[key]));
    expect([...used('header')].sort()).toEqual(['band', 'centered', 'inline', 'minimal']);
    expect([...used('card')].sort()).toEqual(['bordered', 'overlay', 'plain', 'row']);
    expect([...used('product')].sort()).toEqual(['compact', 'split', 'stacked', 'sticky']);
    expect([...used('footer')].sort()).toEqual(['centered', 'columns', 'dark']);
    for (const id of SHOP_TEMPLATE_IDS) expect(PRODUCT_LAYOUT_CLASSES[SHOP_TEMPLATES[id].layout.product]).toBeDefined();
  });

  it('keeps every template readable in its own header, footer and badges (WCAG AA 4.5:1)', () => {
    for (const id of SHOP_TEMPLATE_IDS) {
      const theme = resolveTheme(id, {});
      const { colors, layout } = theme;
      const vars = themeCssVars(theme);
      // The band header and the announcement use the brand color with black or white text.
      if (layout.header === 'band') {
        expect(contrastRatio(vars['--shop-on-primary'], colors.primary), `${id}: band header`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(vars['--shop-on-accent'], colors.accent), `${id}: announcement on band`).toBeGreaterThanOrEqual(4.5);
      }
      // The dark footer swaps page text and background.
      if (layout.footer === 'dark') expect(contrastRatio(colors.background, colors.text), `${id}: dark footer`).toBeGreaterThanOrEqual(4.5);
      // Sale badge: accent with its readable text; quick add: primary with its readable text.
      expect(contrastRatio(readableOn(colors.accent), colors.accent), `${id}: sale badge`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(readableOn(colors.primary), colors.primary), `${id}: quick add`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draws every template with the self-hosted fonts', () => {
    for (const id of SHOP_TEMPLATE_IDS) {
      const { font } = SHOP_TEMPLATES[id];
      expect(SHOP_FONT_IDS).toContain(font.heading);
      expect(SHOP_FONT_IDS).toContain(font.body);
      expect(themeCssVars(resolveTheme(id, {}))['--shop-font-heading']).toMatch(/^Shop[A-Za-z]+, /);
    }
  });
});

describe('self-hosted fonts', () => {
  it('offers eight to ten new fonts, each a self-hosted family with a system fallback', () => {
    expect(SHOP_FONT_IDS.length).toBeGreaterThanOrEqual(8);
    expect(SHOP_FONT_IDS.length).toBeLessThanOrEqual(10);
    for (const id of SHOP_FONT_IDS) expect(SHOP_FONTS[id]).toMatch(/^Shop[A-Za-z]+, .*(sans-serif|serif|monospace)$/);
    expect(Object.values(SHOP_FONTS).join(' ')).not.toMatch(/url\(|https?:|[;{}<>]/);
  });

  it('keeps fonts saved before the change working, without offering them', () => {
    for (const legacy of ['modern', 'humanist', 'rounded', 'classic', 'elegant', 'technical']) {
      expect(parseThemeSettings({ font: { heading: legacy } }).font.heading).toBe(legacy);
      expect(SHOP_FONT_IDS).not.toContain(legacy);
      expect(resolveTheme('wellness', { font: { body: legacy } }).font.body).toBe(legacy);
    }
    expect(parseThemeSettings({ font: { heading: 'playfair', body: 'dm_sans' } }).font).toEqual({ heading: 'playfair', body: 'dm_sans' });
    for (const bad of ['Comic Sans', 'toString', '__proto__', 'constructor']) {
      expect(() => parseThemeSettings({ font: { body: bad } })).toThrow(new ShopThemeError('font.body'));
    }
  });
});

describe('new home sections', () => {
  it('every new type starts valid and survives a round trip', () => {
    for (const type of ['offer', 'trust_badges', 'logo_strip', 'gallery', 'signup', 'best_sellers', 'recently_viewed'] as const) {
      expect(SHOP_SECTION_TYPES).toContain(type);
      const section = newSection(type, 'new001');
      expect(parseSection(JSON.parse(JSON.stringify(section)), 's')).toEqual(section);
    }
  });

  it('validates the offer end time and normalises it to UTC', () => {
    const at = parseSection({ id: 'off001', type: 'offer', settings: { heading: 'Diwali sale', endsAt: '2030-11-01T18:30:00+05:30' } }, 's');
    expect(at.settings.endsAt).toBe('2030-11-01T13:00:00.000Z');
    for (const bad of ['tomorrow', '2030-11-01', '2030-11-01T18:30', '1999-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 42, 'x'.repeat(50)]) {
      expect(() => parseSection({ id: 'off001', type: 'offer', settings: { endsAt: bad } }, 's')).toThrow(new ShopThemeError('s.settings.endsAt'));
    }
    expect(parseMoment('', 'f')).toBeNull();
  });

  it('holds trust badges, logos and gallery pictures to their limits and fixed icons', () => {
    const badge = (icon: string) => ({ icon, text: 'Free delivery' });
    expect(parseSection({ id: 'tru001', type: 'trust_badges', items: TRUST_ICONS.slice(0, 4).map(badge) }, 's').items).toHaveLength(4);
    expect(() => parseSection({ id: 'tru001', type: 'trust_badges', items: TRUST_ICONS.slice(0, 5).map(badge) }, 's')).toThrow(new ShopThemeError('s.items'));
    expect(() => parseSection({ id: 'tru001', type: 'trust_badges', items: [badge('<svg onload=x>')] }, 's')).toThrow(new ShopThemeError('s.items.0.icon'));
    expect(() => parseSection({ id: 'tru001', type: 'trust_badges', items: [{ icon: 'truck', text: 'x'.repeat(61) }] }, 's')).toThrow(new ShopThemeError('s.items.0.text'));

    const logos = Array.from({ length: 8 }, () => ({ image: M, name: 'Brand' }));
    expect(parseSection({ id: 'log001', type: 'logo_strip', items: logos }, 's').items).toHaveLength(8);
    expect(() => parseSection({ id: 'log001', type: 'logo_strip', items: [...logos, logos[0]] }, 's')).toThrow(new ShopThemeError('s.items'));
    expect(() => parseSection({ id: 'log001', type: 'logo_strip', items: [{ image: 'javascript:alert(1)' }] }, 's')).toThrow(new ShopThemeError('s.items.0.image'));

    const pictures = Array.from({ length: 12 }, (_, i) => ({ image: M, link: i % 2 ? '/all' : 'https://example.com/look' }));
    expect(parseSection({ id: 'gal001', type: 'gallery', items: pictures }, 's').items).toHaveLength(12);
    expect(() => parseSection({ id: 'gal001', type: 'gallery', items: [...pictures, pictures[0]] }, 's')).toThrow(new ShopThemeError('s.items'));
    expect(() => parseSection({ id: 'gal001', type: 'gallery', items: [{ image: M, link: '/admin' }] }, 's')).toThrow(new ShopThemeError('s.items.0.link'));
    expect(SECTION_SPECS.gallery.items?.max).toBe(12);
  });

  it('holds best sellers and recently viewed numbers to their ranges', () => {
    expect(parseSection({ id: 'bes001', type: 'best_sellers', settings: {} }, 's').settings).toEqual({ title: null, days: 30, limit: 4 });
    expect(parseSection({ id: 'bes001', type: 'best_sellers', settings: { days: 365, limit: 12 } }, 's').settings.days).toBe(365);
    for (const [key, value] of [['days', 6], ['days', 366], ['limit', 13], ['limit', 1], ['limit', 2.5], ['days', '30']] as const) {
      expect(() => parseSection({ id: 'bes001', type: 'best_sellers', settings: { [key]: value } }, 's')).toThrow(new ShopThemeError(`s.settings.${key}`));
    }
    expect(() => parseSection({ id: 'rec001', type: 'recently_viewed', settings: { limit: 13 } }, 's')).toThrow(new ShopThemeError('s.settings.limit'));
  });

  it('keeps sign-up to plain short texts', () => {
    expect(() => parseSection({ id: 'sig001', type: 'signup', settings: { buttonLabel: 'x'.repeat(31) } }, 's')).toThrow(new ShopThemeError('s.settings.buttonLabel'));
    const s = parseSection({ id: 'sig001', type: 'signup', settings: { heading: ' Join\u0000 us ', html: '<b>x</b>' } }, 's');
    expect(s.settings).toEqual({ heading: 'Join us', text: null, buttonLabel: null });
  });
});

describe('recently viewed ids', () => {
  it('keeps up to twelve distinct well-formed ids and refuses longer lists', () => {
    expect(parseProductIds(null)).toBeNull();
    expect(parseProductIds('')).toEqual([]);
    expect(parseProductIds(`${U(1)}, ${U(1).toUpperCase()},nope,${U(2)}`)).toEqual([U(1), U(2)]);
    expect(parseProductIds(Array.from({ length: RECENT_IDS_MAX }, (_, i) => U(i)).join(','))).toHaveLength(12);
    expect(parseProductIds(Array.from({ length: RECENT_IDS_MAX + 1 }, (_, i) => U(i)).join(','))).toBeNull();
    expect(parseProductIds('x'.repeat(1000))).toBeNull();
  });
});

describe('offer countdown', () => {
  it('splits the time left and stops at zero', () => {
    const end = Date.UTC(2030, 0, 2, 3, 4, 5);
    expect(timeLeft(end, Date.UTC(2030, 0, 1, 0, 0, 0))).toEqual({ days: 1, hours: 3, minutes: 4, seconds: 5, over: false });
    expect(timeLeft(end, end + 1000)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0, over: true });
  });
});
