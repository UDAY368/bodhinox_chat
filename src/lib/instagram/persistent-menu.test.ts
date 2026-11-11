// Stage 3 (3D): persistent menu, pure parts. The database paths (tenancy, the
// Meta sync, the compare-and-set) are in persistent-menu.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { InstagramError } from './errors';
import { persistentMenuFits } from './graph-limits';
import { MAX_MENU_ITEMS, menuItemsForMeta, normaliseMenu, storedMenu } from './persistent-menu';
import { decodePostback } from './postback-payloads';

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return error instanceof InstagramError ? error.code : String(error);
  }
};
const link = (title: string, url = 'https://example.com') => ({ type: 'web_url', title, url });

describe('normaliseMenu', () => {
  it('trims titles, collapses spaces and lower-cases flow ids', () => {
    expect(normaliseMenu([{ type: 'postback', title: '  Book   a call ', flowId: F1.toUpperCase() }]))
      .toEqual([{ type: 'postback', title: 'Book a call', flowId: F1 }]);
  });

  it('allows an empty list (removes the menu) and exactly 20 items', () => {
    expect(normaliseMenu([])).toEqual([]);
    expect(normaliseMenu(Array.from({ length: MAX_MENU_ITEMS }, (_, i) => link(`T${i}`)))).toHaveLength(20);
  });

  it('refuses more than 20 items', () => {
    expect(codeOf(() => normaliseMenu(Array.from({ length: MAX_MENU_ITEMS + 1 }, (_, i) => link(`T${i}`))))).toBe('invalid_request');
  });

  it('refuses an empty, over-long or repeated title', () => {
    expect(codeOf(() => normaliseMenu([link('   ')]))).toBe('invalid_request');
    expect(codeOf(() => normaliseMenu([link('x'.repeat(31))]))).toBe('invalid_request');
    expect(codeOf(() => normaliseMenu([link('x'.repeat(30))]))).toBe('ok');
    expect(codeOf(() => normaliseMenu([link('Shop'), { type: 'postback', title: ' shop ', flowId: F1 }]))).toBe('invalid_request');
  });

  it('refuses a link that is not https, a bad flow id and an unknown type', () => {
    expect(codeOf(() => normaliseMenu([link('A', 'http://example.com')]))).toBe('invalid_request');
    expect(codeOf(() => normaliseMenu([link('A', 'javascript:alert(1)')]))).toBe('invalid_request');
    expect(codeOf(() => normaliseMenu([{ type: 'postback', title: 'A', flowId: 'nope' }]))).toBe('invalid_request');
    expect(codeOf(() => normaliseMenu([{ type: 'phone', title: 'A' }]))).toBe('invalid_request');
  });
});

describe('storedMenu', () => {
  it('reads the stored list and skips anything malformed', () => {
    expect(storedMenu([
      { type: 'postback', title: 'Book', flow_id: F1 },
      { type: 'web_url', title: 'Site', url: 'https://example.com' },
      { type: 'web_url', title: 'Plain', url: 'http://example.com' },
      { type: 'postback', title: '', flow_id: F2 },
      { type: 'postback', title: 'Bad', flow_id: 'x' },
      null,
    ])).toEqual([{ type: 'postback', title: 'Book', flowId: F1 }, { type: 'web_url', title: 'Site', url: 'https://example.com' }]);
    expect(storedMenu(null)).toEqual([]);
    expect(storedMenu({})).toEqual([]);
  });
});

describe('menuItemsForMeta', () => {
  it('posts back menu:<flow id>, which decodes to the flow, and the result fits Meta limits', () => {
    const items = menuItemsForMeta(normaliseMenu([{ type: 'postback', title: 'Book', flowId: F1 }, link('Site')]));
    expect(items).toEqual([{ type: 'postback', title: 'Book', payload: `menu:${F1}` }, { type: 'web_url', title: 'Site', url: 'https://example.com' }]);
    expect(decodePostback(`menu:${F1}`)).toEqual({ kind: 'menu', flowId: F1 });
    expect(persistentMenuFits(items)).toBe(true);
  });
});
