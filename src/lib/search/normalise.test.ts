import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AudienceFilterError } from '@/lib/audience/filter';
import { contactMatchSql } from './contacts';
import { orderTitle } from './global';
import {
  containsPattern, decodeCursor, encodeCursor, isPhoneTerm, parseLimit, parseQuery, referenceTerm, searchDigits,
} from './normalise';

describe('search term normalisation', () => {
  it('reduces every phone format to the same digits', () => {
    for (const typed of ['98765 43210', '+91 98765', '9876543210', '(987) 654-3210'])
      expect(isPhoneTerm(typed)).toBe(true);
    expect(searchDigits('+91 98765 43210')).toBe('919876543210');
    expect(searchDigits('98765 43210')).toBe('9876543210');
  });

  it('treats a term with letters as a name, not a number', () => {
    expect(isPhoneTerm('Asha 2')).toBe(false);
    expect(isPhoneTerm('+')).toBe(false);
    expect(isPhoneTerm('  ')).toBe(false);
  });

  it('matches LIKE wildcards literally', () => {
    expect(containsPattern(String.raw` 50%_off\ `)).toBe(String.raw`%50\%\_off\\%`);
  });

  it('reads an order reference with or without #', () => {
    expect(referenceTerm('#AB12')).toBe('ab12');
    expect(orderTitle('abcdef12-0000-4000-8000-000000000000', null)).toBe('ABCDEF12');
    expect(orderTitle('abcdef12-0000-4000-8000-000000000000', '1042')).toBe('#1042');
  });

  it('caps the limit and refuses junk', () => {
    expect(parseLimit(null, 20, 50)).toBe(20);
    expect(parseLimit('500', 20, 50)).toBe(50);
    expect(() => parseLimit('0', 20, 50)).toThrow(AudienceFilterError);
    expect(() => parseLimit('2.5', 20, 50)).toThrow(AudienceFilterError);
    expect(() => parseQuery('x'.repeat(101))).toThrow(AudienceFilterError);
    expect(parseQuery('  asha ')).toBe('asha');
  });
});

describe('search cursor', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('round-trips a microsecond position and a null one', () => {
    const at = '2026-11-19T10:11:12.123456Z';
    expect(decodeCursor(encodeCursor({ at, id }))).toEqual({ at, id });
    expect(decodeCursor(encodeCursor({ at: null, id }))).toEqual({ at: null, id });
  });

  it('refuses a tampered cursor', () => {
    for (const raw of ['nope', encodeCursor({ at: "2026-11-19'; DROP", id }), Buffer.from('["x","y"]').toString('base64url')])
      expect(() => decodeCursor(raw)).toThrow(AudienceFilterError);
  });
});

describe('contact match SQL', () => {
  const text = (sql: Prisma.Sql) => sql.sql;

  it('matches a number by its digits for an unmasked member', () => {
    const sql = contactMatchSql('+91 98765', false);
    expect(text(sql)).toContain('phone_normalized LIKE');
    expect(sql.values).toContain('%9198765%');
  });

  it('lets a masked member search by the last four digits only', () => {
    expect(contactMatchSql('3210', true).values).toContain('%3210');
    const long = contactMatchSql('98765 43210', true);
    expect(text(long)).not.toContain('phone_normalized');
    expect(text(contactMatchSql('asha', true))).not.toContain('username');
  });

  it('matches names and Instagram usernames for a text term', () => {
    const sql = contactMatchSql('@asha', false);
    expect(text(sql)).toContain('i.username ILIKE');
    expect(sql.values).toEqual(['%@asha%', '%asha%']);
    expect(contactMatchSql('  ', false)).toBe(Prisma.empty);
  });
});
