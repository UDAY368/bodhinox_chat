import { describe, expect, it } from 'vitest';
import { AudienceFilterError, compileAudienceFilter, parseAudienceFilter } from './filter';
import { csvCell } from './export';

const tag = '00000000-0000-4000-8000-000000000001';
const account = '00000000-0000-4000-8000-0000000000aa';

describe('parseAudienceFilter', () => {
  it('accepts every supported condition', () => {
    const filter = parseAudienceFilter({
      conditions: [
        { field: 'tags', op: 'has_any', tagIds: [tag] },
        { field: 'custom_field', fieldId: tag, op: 'contains', value: 'gold' },
        { field: 'custom_field', fieldId: tag, op: 'is_empty' },
        { field: 'name', op: 'is_not_empty' },
        { field: 'created_at', op: 'after', value: '2026-01-31' },
        { field: 'opted_out', op: 'is', value: false },
      ],
    });
    expect(filter.conditions).toHaveLength(6);
  });

  it.each<[unknown, string]>([
    [{}, 'no conditions'],
    [{ conditions: [] }, 'empty list'],
    [{ conditions: [{ field: 'tags', op: 'has_any', tagIds: [] }] }, 'no tags'],
    [{ conditions: [{ field: 'name', op: 'contains' }] }, 'missing value'],
    [{ conditions: [{ field: 'name', op: 'contains', value: 'x', extra: 1 }] }, 'unknown key'],
    [{ conditions: [{ field: 'password_hash', op: 'contains', value: 'x' }] }, 'unknown field'],
    [{ conditions: [{ field: 'created_at', op: 'after', value: 'yesterday' }] }, 'bad date'],
    [{ conditions: [{ field: 'tags', op: 'has_any', tagIds: ["1' OR '1'='1"] }] }, 'non-uuid tag'],
    [{ conditions: Array.from({ length: 21 }, () => ({ field: 'name', op: 'is_empty' })) }, 'too many'],
  ])('rejects %j (%s)', (input) => {
    expect(() => parseAudienceFilter(input)).toThrow(AudienceFilterError);
  });

  it('binds every value as a parameter, never as SQL text', () => {
    const value = "x'; DROP TABLE contacts; --";
    const sql = compileAudienceFilter(account, parseAudienceFilter({ conditions: [{ field: 'name', op: 'contains', value }] }));
    expect(sql.sql).not.toContain('DROP');
    expect(sql.values).toContain(`%${value}%`);
  });

  it('escapes LIKE wildcards in contains', () => {
    const sql = compileAudienceFilter(account, parseAudienceFilter({ conditions: [{ field: 'email', op: 'contains', value: '50%_off' }] }));
    expect(sql.values).toContain('%50\\%\\_off%');
  });
});

describe('csvCell', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(csvCell('Say "hi", ok')).toBe('"Say ""hi"", ok"');
    expect(csvCell(null)).toBe('""');
  });
  it.each(['=SUM(A1)', '+1 555', '-2', '@cmd', '\tx'])('neutralises the formula %j', (value) => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });
});
