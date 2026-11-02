import { describe, expect, it } from 'vitest';
import { containsSnippet, SNIPPET_END, SNIPPET_START, splitSnippet, stripSnippetMarkers } from './search-snippet';

const S = SNIPPET_START, E = SNIPPET_END;

describe('splitSnippet', () => {
  it('splits marked runs and keeps markup as plain text', () => {
    expect(splitSnippet(`my ${S}order${E} is <b>late</b>`)).toEqual([
      { text: 'my ', match: false },
      { text: 'order', match: true },
      { text: ' is <b>late</b>', match: false },
    ]);
  });

  it('tolerates unbalanced markers and empty input', () => {
    expect(splitSnippet(`${S}open`)).toEqual([{ text: 'open', match: true }]);
    expect(splitSnippet(`a${E}b`)).toEqual([{ text: 'a', match: false }, { text: 'b', match: false }]);
    expect(splitSnippet('')).toEqual([]);
  });
});

describe('containsSnippet', () => {
  it('marks the first case-insensitive occurrence', () => {
    expect(containsSnippet('Hello OK there', 'ok')).toBe(`Hello ${S}OK${E} there`);
  });

  it('trims long text around the match with ellipses', () => {
    const text = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
    expect(containsSnippet(text, 'needle', 10)).toBe(`…${'a'.repeat(9)} ${S}needle${E} ${'b'.repeat(9)}…`);
  });

  it('returns unmarked leading text without an occurrence, and strips stray markers from content', () => {
    expect(containsSnippet(`x${S}y`, 'zz')).toBe('xy');
    expect(containsSnippet('c'.repeat(300), 'zz')).toBe(`${'c'.repeat(240)}…`);
    expect(containsSnippet(null, 'a')).toBe('');
    expect(stripSnippetMarkers(`${S}a${E}`)).toBe('a');
  });
});
