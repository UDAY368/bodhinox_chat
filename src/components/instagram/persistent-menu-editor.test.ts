import { describe, expect, it } from 'vitest';
import { menuProblem, normaliseTitle, type MenuRow } from './persistent-menu-editor';

const F1 = '11111111-1111-4111-8111-111111111111';
const flows = new Set([F1]);
const flow = (title: string, flowId = F1): MenuRow => ({ type: 'postback', title, flowId, url: '' });
const link = (title: string, url = 'https://example.com'): MenuRow => ({ type: 'web_url', title, flowId: '', url });

describe('menuProblem', () => {
  it('accepts an empty menu and a valid mix', () => {
    expect(menuProblem([], flows)).toBeNull();
    expect(menuProblem([flow('Book'), link('Site')], flows)).toBeNull();
  });

  it('refuses 21 items, a blank, over-long or repeated title', () => {
    expect(menuProblem(Array.from({ length: 21 }, (_, i) => link(`T${i}`)), flows)).toBe('max');
    expect(menuProblem([link('  ')], flows)).toBe('title');
    expect(menuProblem([link('x'.repeat(31))], flows)).toBe('tooLong');
    expect(menuProblem([link('Shop'), flow(' SHOP ')], flows)).toBe('duplicate');
  });

  it('refuses a flow that is not an option and a link that is not https', () => {
    expect(menuProblem([flow('A', 'other')], flows)).toBe('flow');
    expect(menuProblem([link('A', 'http://example.com')], flows)).toBe('url');
  });

  it('normalises titles like the server', () => {
    expect(normaliseTitle('  a   b ')).toBe('a b');
  });
});
