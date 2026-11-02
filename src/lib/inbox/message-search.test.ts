import { describe, expect, it } from 'vitest';
import { messageSearchVector, normalizeMessageSearch } from './message-search';

describe('messageSearchVector', () => {
  it('renders the indexed expression for an alias', () => {
    expect(messageSearchVector('m').sql).toBe("to_tsvector('simple'::regconfig, COALESCE(m.content_text, ''))");
  });
  it('rejects anything but a plain alias', () => {
    expect(() => messageSearchVector('m; DROP TABLE messages')).toThrow('Invalid table alias');
  });
});

describe('normalizeMessageSearch', () => {
  it('trims, collapses whitespace and caps length', () => {
    expect(normalizeMessageSearch('  order \n  4521 ')).toBe('order 4521');
    expect(normalizeMessageSearch('a'.repeat(500))).toHaveLength(200);
  });
  it('keeps non-Latin text', () => expect(normalizeMessageSearch('पेमेंट')).toBe('पेमेंट'));
  it('returns null for nothing searchable', () => {
    expect(normalizeMessageSearch('   ')).toBeNull();
    expect(normalizeMessageSearch('"" - !')).toBeNull();
    expect(normalizeMessageSearch(7)).toBeNull();
  });
});
