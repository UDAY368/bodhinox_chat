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
        { field: 'list', op: 'in_none', listIds: [tag] },
      ],
    });
    expect(filter.conditions).toHaveLength(7);
  });

  it('compiles campaign outcomes to recipient statuses, negating only not_received', () => {
    const one = (op: string) => compileAudienceFilter(account, parseAudienceFilter({ conditions: [{ field: 'campaign', broadcastId: tag, op }] }));
    expect(one('read').values).toEqual(expect.arrayContaining([tag, 'read', 'replied']));
    expect(one('read').sql).not.toContain('NOT EXISTS');
    expect(one('not_read').values).toEqual(expect.arrayContaining(['sent', 'delivered']));
    expect(one('not_received').sql).toContain('NOT EXISTS(SELECT 1 FROM broadcast_recipients r');
    expect(() => parseAudienceFilter({ conditions: [{ field: 'campaign', broadcastId: tag, op: 'opened' }] })).toThrow(AudienceFilterError);
    expect(() => parseAudienceFilter({ conditions: [{ field: 'campaign', broadcastId: 'x', op: 'read' }] })).toThrow(AudienceFilterError);
  });

  it('compiles a list condition to a scoped membership check with bound ids', () => {
    const sql = compileAudienceFilter(account, parseAudienceFilter({ conditions: [{ field: 'list', op: 'in_none', listIds: [tag] }] }));
    expect(sql.sql).toContain('NOT EXISTS(SELECT 1 FROM contact_list_members m WHERE m.account_id=');
    expect(sql.values).toContain(JSON.stringify([tag]));
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
    [{ conditions: [{ field: 'list', op: 'in_any', listIds: [] }] }, 'no lists'],
    [{ conditions: [{ field: 'list', op: 'has_any', listIds: [tag] }] }, 'tag operator on a list'],
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
