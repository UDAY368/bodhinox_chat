import { describe, expect, it } from 'vitest';
import { isolateOutside } from './use-isolate-overlay';

type FakeEl = {
  name: string;
  tagName: string;
  parentElement: FakeEl | null;
  children: FakeEl[];
  attrs: Set<string>;
  hasAttribute(name: string): boolean;
  setAttribute(name: string): void;
  removeAttribute(name: string): void;
};

function el(name: string, tagName = 'DIV', children: FakeEl[] = [], attrs: string[] = []): FakeEl {
  const node: FakeEl = {
    name, tagName, parentElement: null, children, attrs: new Set(attrs),
    hasAttribute: (a) => node.attrs.has(a),
    setAttribute: (a) => { node.attrs.add(a); },
    removeAttribute: (a) => { node.attrs.delete(a); },
  };
  children.forEach((c) => { c.parentElement = node; });
  return node;
}

describe('isolateOutside', () => {
  it('makes everything outside the overlay chain inert and undoes only what it set', () => {
    const editor = el('editor');
    const header = el('header');
    const main = el('main', 'MAIN', [header, editor]);
    const sidebar = el('sidebar', 'ASIDE');
    const shell = el('shell', 'DIV', [sidebar, main]);
    const already = el('already', 'DIV', [], ['inert']);
    const toaster = el('toaster', 'SECTION', [], ['data-sonner-toaster']);
    const script = el('script', 'SCRIPT');
    const body = el('body', 'BODY', [shell, already, toaster, script]);

    const undo = isolateOutside(editor, body);
    expect(header.attrs.has('inert')).toBe(true);
    expect(sidebar.attrs.has('inert')).toBe(true);
    expect([editor, main, shell].some((n) => n.attrs.has('inert'))).toBe(false);
    expect(toaster.attrs.has('inert')).toBe(false);
    expect(script.attrs.has('inert')).toBe(false);

    undo();
    expect(header.attrs.has('inert')).toBe(false);
    expect(sidebar.attrs.has('inert')).toBe(false);
    expect(already.attrs.has('inert')).toBe(true);
  });
});
