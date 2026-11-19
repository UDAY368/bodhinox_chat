import { describe, expect, it } from 'vitest';
import {
  contrastRatio, normaliseHandle, parseThemeSettings, readableOn, readThemeSettings, resolveTheme, safeHttpsUrl, SHOP_TEMPLATE_IDS, SHOP_TEMPLATES,
  ShopThemeError, suggestHandle, themeCssVars,
} from './shop-templates';

describe('shop templates', () => {
  it('has six templates, each with valid colors and fonts', () => {
    expect(SHOP_TEMPLATE_IDS).toEqual(['wellness', 'fashion', 'beauty', 'food', 'grocery', 'electronics']);
    for (const id of SHOP_TEMPLATE_IDS) {
      const tpl = SHOP_TEMPLATES[id];
      expect(Object.values(tpl.colors).every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
      // Text on the template's main color reads well enough (WCAG large text 3:1 is always met by black or white).
      expect(['#000000', '#ffffff']).toContain(readableOn(tpl.colors.primary));
    }
  });

  it('keeps only the fixed brand fields and validates each one', () => {
    const parsed = parseThemeSettings({
      colors: { primary: '#AABBCC', accent: '' }, font: { heading: 'elegant' }, logo: 'https://cdn.example.com/logo.png',
      banner: 'media:0b8c3c3e-8a5e-4d6c-9a52-0f6f2b1d2e3f', headline: '  Hello\u0000 shop  ', social: { instagram: 'https://instagram.com/shop' },
      css: 'body{display:none}', script: '<script>alert(1)</script>', liquid: '{{ shop.secret }}',
    });
    expect(parsed).toEqual({
      colors: { primary: '#aabbcc' }, font: { heading: 'elegant' }, logo: 'https://cdn.example.com/logo.png',
      banner: 'media:0b8c3c3e-8a5e-4d6c-9a52-0f6f2b1d2e3f', headline: 'Hello shop', subheadline: null, announcement: null,
      social: { instagram: 'https://instagram.com/shop', facebook: null, youtube: null },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/script|display|secret/);
  });

  it.each([
    ['colors.primary', { colors: { primary: 'red' } }],
    ['colors.text', { colors: { text: '#fff; background:url(x)' } }],
    ['font.body', { font: { body: 'Comic Sans' } }],
    ['logo', { logo: 'javascript:alert(1)' }],
    ['logo', { logo: 'http://insecure.example.com/a.png' }],
    ['banner', { banner: 'https://user:pass@example.com/a.png' }],
    ['banner', { banner: 'data:image/png;base64,AAAA' }],
    ['social.instagram', { social: { instagram: 'https://evil.example.com/instagram.com' } }],
    ['social.youtube', { social: { youtube: 'https://youtube.com.evil.example/x' } }],
    ['headline', { headline: 'x'.repeat(81) }],
    ['announcement', { announcement: 42 }],
  ])('refuses a bad %s', (field, input) => {
    expect(() => parseThemeSettings(input)).toThrow(new ShopThemeError(field));
  });

  it('reads stored settings leniently and falls back to the template', () => {
    expect(readThemeSettings({ colors: { primary: 'nope' } }).colors).toEqual({});
    const theme = resolveTheme('fashion', { colors: { accent: '#123456' } });
    expect(theme.colors).toEqual({ ...SHOP_TEMPLATES.fashion.colors, accent: '#123456' });
    expect(theme.font).toEqual(SHOP_TEMPLATES.fashion.font);
    expect(resolveTheme('unknown', null).template).toBe('wellness');
    const vars = themeCssVars(theme);
    expect(vars['--shop-accent']).toBe('#123456');
    expect(Object.values(vars).join(' ')).not.toMatch(/[;{}<>]/);
  });

  it('accepts only https URLs without credentials', () => {
    expect(safeHttpsUrl('https://example.com/a b.png')).toBe('https://example.com/a%20b.png');
    expect(safeHttpsUrl('ftp://example.com/a')).toBeNull();
    expect(safeHttpsUrl('https://x'.padEnd(600, 'x'))).toBeNull();
  });

  it('normalises handles and refuses reserved or malformed ones', () => {
    expect(normaliseHandle(' Kumar-Ayurveda ')).toBe('kumar-ayurveda');
    for (const bad of ['ab', '-shop', 'shop-', 'my--shop', 'admin', 'api', 'a_b', 'x'.repeat(41), 7]) expect(normaliseHandle(bad)).toBeNull();
    expect(suggestHandle("Kumar's Ayurveda & Co.")).toBe('kumar-s-ayurveda-co');
    expect(suggestHandle('')).toBe('my-shop');
  });
});

describe('theme preset accessibility', () => {
  it('keeps body text, prices and button text readable (WCAG AA, 4.5:1) in every template', () => {
    for (const id of SHOP_TEMPLATE_IDS) {
      const { colors } = SHOP_TEMPLATES[id];
      for (const [name, a, b] of [
        ['text on background', colors.text, colors.background], ['text on surface', colors.text, colors.surface],
        ['primary (prices) on background', colors.primary, colors.background], ['primary (prices) on surface', colors.primary, colors.surface],
        ['button text on primary', readableOn(colors.primary), colors.primary], ['button text on accent', readableOn(colors.accent), colors.accent],
      ] as const) expect(contrastRatio(a, b), `${id}: ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('measures contrast the WCAG way', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });
});