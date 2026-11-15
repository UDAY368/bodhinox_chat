import { describe, expect, it } from 'vitest';
import {
  categoryTree, contentMediaIds, defaultSections, newSection, pagesOn, parseLink, parseShopContent, parseShopDocument, pickProducts,
  readShopContent, readShopDocument, SHOP_CONTENT_LIMITS, SHOP_SECTION_TYPES, shopHref, youtubeId,
} from './shop-sections';
import { ShopThemeError } from './shop-templates';

const M1 = 'media:11111111-1111-4111-8111-111111111111';
const M2 = 'media:22222222-2222-4222-8222-222222222222';
const CAT = '33333333-3333-4333-8333-333333333333';

const fieldOf = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof ShopThemeError ? error.field : 'other'; }
  return null;
};

describe('shop links', () => {
  it('accepts shop paths and https URLs only', () => {
    expect(parseLink('/', 'l')).toBe('/');
    expect(parseLink('/all', 'l')).toBe('/all');
    expect(parseLink(`/c/${CAT}`, 'l')).toBe(`/c/${CAT}`);
    expect(parseLink('/pages/refund', 'l')).toBe('/pages/refund');
    expect(parseLink('https://wa.me/919800000000', 'l')).toBe('https://wa.me/919800000000');
    expect(parseLink('', 'l')).toBeNull();
    for (const bad of ['javascript:alert(1)', 'http://example.com', '//evil.example', '/admin', '/pages/secret', '/c/not-a-uuid',
      'data:text/html,hi', 'https://user:pw@example.com', '/../api/x', 42]) expect(fieldOf(() => parseLink(bad, 'l'))).toBe('l');
  });

  it('turns stored links into hrefs on the shop', () => {
    expect(shopHref('/', '/s/kumar')).toEqual({ href: '/s/kumar', external: false });
    expect(shopHref('/all', '/s/kumar')).toEqual({ href: '/s/kumar/all', external: false });
    expect(shopHref('https://instagram.com/kumar', '/s/kumar')).toEqual({ href: 'https://instagram.com/kumar', external: true });
    expect(shopHref(null, '/s/kumar')).toBeNull();
    expect(shopHref('javascript:alert(1)', '/s/kumar')).toBeNull();
  });

  it('reads YouTube ids from the usual link shapes', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeId('https://youtu.be/"><script>')).toBeNull();
  });
});

describe('sections', () => {
  it('validates every section type to its fixed fields and drops unknown keys', () => {
    const sections = SHOP_SECTION_TYPES.map((type, i) => ({ ...newSection(type, `sec${i}x`), extra: '<script>', settings: { html: '<b>x</b>' } }));
    const content = parseShopContent({ sections, css: 'body{}', liquid: '{{ x }}' });
    expect(content.sections).toHaveLength(SHOP_SECTION_TYPES.length);
    expect(JSON.stringify(content)).not.toMatch(/script|html|css|liquid/);
    expect(Object.keys(content).sort()).toEqual(['footer', 'menu', 'pages', 'policies', 'sections']);
  });

  it('keeps text as plain text, with line breaks only where paragraphs allow them', () => {
    const [text] = parseShopContent({ sections: [{ id: 'txt001', type: 'text', settings: { heading: 'Hi\nthere\u0000', text: 'One\r\n\r\n\r\n\r\nTwo <b>bold</b>' } }] }).sections;
    expect(text.settings.heading).toBe('Hi there');
    expect(text.settings.text).toBe('One\n\nTwo <b>bold</b>');
  });

  it('refuses bad values with their path', () => {
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'a', type: 'text' }] }))).toBe('sections.0.id');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'iframe' }] }))).toBe('sections.0.type');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'banner', settings: { style: 'wild' } }] }))).toBe('sections.0.settings.style');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'product_grid', settings: { limit: 500 } }] }))).toBe('sections.0.settings.limit');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'banner', settings: { image: 'http://x.example/a.png' } }] }))).toBe('sections.0.settings.image');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'video', settings: { video: 'javascript:1' } }] }))).toBe('sections.0.settings.video');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'featured_collection', settings: { category: 'x' } }] }))).toBe('sections.0.settings.category');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'faq', items: new Array(21).fill({}) }] }))).toBe('sections.0.items');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'text' }, { id: 'abcd1', type: 'text' }] }))).toBe('sections.id');
    expect(fieldOf(() => parseShopContent({ sections: Array.from({ length: SHOP_CONTENT_LIMITS.sections + 1 }, (_, i) => ({ id: `sec${i}xx`, type: 'text' })) }))).toBe('sections');
    expect(fieldOf(() => parseShopContent({ menu: [{ label: 'x', link: 'javascript:1' }] }))).toBe('menu.0.link');
    expect(fieldOf(() => parseShopContent({ menu: new Array(9).fill({ label: 'x', link: '/' }) }))).toBe('menu');
    expect(fieldOf(() => parseShopContent({ footer: { contact: { email: 'not an email' } } }))).toBe('footer.contact.email');
    expect(fieldOf(() => parseShopContent({ footer: { contact: { phone: '<script>' } } }))).toBe('footer.contact.phone');
    expect(fieldOf(() => parseShopContent({ sections: [{ id: 'abcd1', type: 'text', settings: { text: 'x'.repeat(2001) } }] }))).toBe('sections.0.settings.text');
    expect(fieldOf(() => parseShopDocument({ template: 'custom', sections: [] }))).toBe('template');
  });

  it('caps the whole content size', () => {
    const big = Array.from({ length: 25 }, (_, i) => ({ id: `big${i}xx`, type: 'faq', items: Array.from({ length: 20 }, () => ({ question: 'q'.repeat(160), answer: 'a'.repeat(1000) })) }));
    expect(fieldOf(() => parseShopContent({ sections: big }))).toBe('document');
  });

  it('reads stored content leniently: a broken section is dropped, an old shop gets the default home page', () => {
    expect(readShopContent({}).sections).toEqual(defaultSections());
    expect(readShopContent(null).sections).toEqual(defaultSections());
    const stored = readShopContent({ sections: [{ id: 'good01', type: 'text', settings: { heading: 'Hi' } }, { id: 'bad', type: 'text' },
      { id: 'evil01', type: 'banner', settings: { buttonLink: 'javascript:1' } }], menu: 'nope' });
    expect(stored.sections.map((s) => s.id)).toEqual(['good01']);
    expect(stored.menu).toEqual([]);
    expect(readShopContent({ sections: [] }).sections).toEqual([]);
  });

  it('falls back from a broken draft to the published state', () => {
    const doc = readShopDocument({ template: 'nope' }, { template: 'food', theme: { colors: { primary: '#123456' } }, document: {} });
    expect(doc.template).toBe('food');
    expect(doc.theme.colors.primary).toBe('#123456');
    expect(doc.sections).toEqual(defaultSections());
  });
});

describe('what pages read', () => {
  it('lists media ids of visible sections, the theme and the About page only', () => {
    const content = parseShopContent({
      sections: [
        { id: 'img001', type: 'image_text', settings: { image: M1 } },
        { id: 'hid001', type: 'image_text', hidden: true, settings: { image: M2 } },
        { id: 'sld001', type: 'slideshow', items: [{ image: 'https://cdn.example.com/a.png' }] },
      ],
      pages: { about: { body: 'x', image: M2.toUpperCase().replace('MEDIA', 'media') } },
    });
    const ids = contentMediaIds({ logo: M1, banner: null } as never, content);
    expect(ids.sort()).toEqual([M1.slice(6), M2.slice(6)].sort());
    expect(contentMediaIds({ logo: null, banner: null } as never, parseShopContent({ sections: [{ id: 'hid001', type: 'image_text', hidden: true, settings: { image: M2 } }] }))).toEqual([]);
  });

  it('knows which store pages exist', () => {
    expect(pagesOn(parseShopContent({}))).toEqual({ about: false, contact: false, faq: false });
    expect(pagesOn(parseShopContent({ pages: { about: { body: 'Us' }, faq: { items: [{ question: 'Q', answer: 'A' }] } }, footer: { contact: { hours: '9 to 5' } } })))
      .toEqual({ about: true, contact: true, faq: true });
  });

  it('picks products for a section by category tree, order and count', () => {
    const child = '44444444-4444-4444-8444-444444444444';
    const p = (id: string, name: string, price: number, categoryId: string | null) => ({ id, name, categoryId, variants: [{ priceMinor: price }] });
    const products = [p('a', 'Cumin', 300, CAT), p('b', 'Amla', 100, child), p('c', 'Neem', 200, null)];
    const tree = categoryTree([{ id: CAT, parentId: null }, { id: child, parentId: CAT }]);
    expect(pickProducts(products, { limit: 8, sort: 'featured' }, tree).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(pickProducts(products, { limit: 2, sort: 'price_asc' }, tree).map((x) => x.id)).toEqual(['b', 'c']);
    expect(pickProducts(products, { limit: 8, sort: 'name', category: CAT }, tree).map((x) => x.id)).toEqual(['b', 'a']);
    expect(pickProducts(products, { limit: 8, category: '55555555-5555-4555-8555-555555555555' }, tree)).toEqual([]);
  });
});
