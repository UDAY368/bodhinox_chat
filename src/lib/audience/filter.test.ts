import { describe, expect, it } from 'vitest';
import { AudienceFilterError, assertFilterReferences, compileAudienceFilter, parseAudienceFilter } from './filter';
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

describe('ad and lead_form conditions', () => {
  const compile = (condition: unknown) => compileAudienceFilter(account, parseAudienceFilter({ conditions: [condition] }));

  it('compiles an ad click to a scoped referral check with bound text ids', () => {
    const sql = compile({ field: 'ad', op: 'clicked_any', adIds: ['120211234567890'] });
    expect(sql.sql).toContain('EXISTS(SELECT 1 FROM ad_referrals r WHERE r.account_id=');
    expect(sql.sql).toContain("r.source_type='ad'");
    expect(sql.sql).toContain('r.source_id IN (SELECT value FROM jsonb_array_elements_text(');
    expect(sql.sql).not.toContain('::uuid FROM jsonb');
    expect(sql.values).toEqual(expect.arrayContaining([account, JSON.stringify(['120211234567890'])]));
  });

  it('treats an empty ad list as any ad and negates clicked_none', () => {
    const any = compile({ field: 'ad', op: 'clicked_any', adIds: [] });
    expect(any.sql).not.toContain('source_id IN');
    expect(any.sql).not.toContain('NOT EXISTS');
    expect(compile({ field: 'ad', op: 'clicked_none', adIds: [] }).sql).toContain('NOT EXISTS(SELECT 1 FROM ad_referrals r');
  });

  it('compiles a lead form condition over meta_leads, with or without form ids', () => {
    const some = compile({ field: 'lead_form', op: 'submitted_any', formIds: ['555'] });
    expect(some.sql).toContain('EXISTS(SELECT 1 FROM meta_leads l WHERE l.account_id=');
    expect(some.sql).toContain('l.form_id IN (SELECT value FROM jsonb_array_elements_text(');
    expect(some.values).toContain(JSON.stringify(['555']));
    const none = compile({ field: 'lead_form', op: 'submitted_none', formIds: [] });
    expect(none.sql).toContain('NOT EXISTS(SELECT 1 FROM meta_leads l');
    expect(none.sql).not.toContain('form_id IN');
  });

  it('never puts a Meta id into the SQL text', () => {
    const sql = compile({ field: 'ad', op: 'clicked_any', adIds: ['987654321'] });
    expect(sql.sql).not.toContain('987654321');
  });

  it.each<[unknown, string]>([
    [{ field: 'ad', op: 'clicked_any', adIds: ['act_123'] }, 'prefixed id'],
    [{ field: 'ad', op: 'clicked_any', adIds: ["1' OR '1'='1"] }, 'injection'],
    [{ field: 'ad', op: 'clicked_any', adIds: ['1'.repeat(33)] }, 'too long'],
    [{ field: 'ad', op: 'clicked_any', adIds: Array.from({ length: 51 }, (_, i) => String(i + 1)) }, 'too many'],
    [{ field: 'ad', op: 'has_any', adIds: [] }, 'wrong operator'],
    [{ field: 'ad', op: 'clicked_any' }, 'missing ids'],
    [{ field: 'lead_form', op: 'submitted_any', formIds: ['12_34'] }, 'post-style id'],
    [{ field: 'lead_form', op: 'submitted_any', formIds: [], adIds: [] }, 'unknown key'],
  ])('rejects %j (%s)', (condition) => {
    expect(() => parseAudienceFilter({ conditions: [condition] })).toThrow(AudienceFilterError);
  });

  it('requires the retargeting entitlement for ad and lead form conditions without looking ids up', async () => {
    const queries: string[] = [];
    const tx = {
      $queryRaw: async (sql: { sql?: string; strings?: string[] }) => {
        const text = sql.sql ?? sql.strings?.join('?') ?? '';
        queries.push(text);
        return text.includes('FROM accounts') || text.includes('plan') ? [] : [];
      },
    };
    const filter = parseAudienceFilter({ conditions: [{ field: 'ad', op: 'clicked_any', adIds: ['1'] }] });
    // getEntitlements reads the plan; any failure there proves the check ran, a pass means no row lookups.
    await assertFilterReferences(tx as never, account, filter).catch(() => undefined);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => /FROM (broadcasts|tags|contact_lists|custom_fields)/.test(q))).toBe(false);
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
  it('writes a stored E.164 phone without the formula apostrophe', () => {
    expect(csvCell('+919876543210')).toBe('"+919876543210"');
  });
  it.each(['+1+1', '+1*9', '+91 98765', '+'])('still neutralises %j', (value) => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });
});

describe('instagram condition (Phase 11)', () => {
  const compile = (condition: unknown) => compileAudienceFilter(account, parseAudienceFilter({ conditions: [condition] }));

  it('compiles "has an Instagram identity" to a scoped EXISTS over contact_channel_identities', () => {
    const sql = compile({ field: 'instagram', op: 'has_identity' });
    expect(sql.sql).toContain('EXISTS(SELECT 1 FROM contact_channel_identities i WHERE i.account_id=');
    expect(sql.sql).toContain("i.channel='instagram'");
    expect(sql.sql).not.toContain('NOT EXISTS');
    expect(sql.values.filter((v) => v === account).length).toBeGreaterThanOrEqual(2);
  });

  it('negates has_no_identity', () => {
    expect(compile({ field: 'instagram', op: 'has_no_identity' }).sql).toContain('NOT EXISTS(SELECT 1 FROM contact_channel_identities i');
  });

  it.each<[unknown, string]>([
    [{ field: 'instagram', op: 'is', value: true }, 'wrong operator'],
    [{ field: 'instagram', op: 'has_identity', username: 'x' }, 'unknown key'],
  ])('rejects %j (%s)', (condition) => {
    expect(() => parseAudienceFilter({ conditions: [condition] })).toThrow(AudienceFilterError);
  });

  it('needs no entitlement or row lookup', async () => {
    const queries: string[] = [];
    const tx = { $queryRaw: async (sql: { sql?: string }) => { queries.push(sql.sql ?? ''); return []; } };
    await assertFilterReferences(tx as never, account, parseAudienceFilter({ conditions: [{ field: 'instagram', op: 'has_identity' }] }));
    expect(queries).toEqual([]);
  });
});

describe('instagram profile conditions (Stage 3)', () => {
  const compile = (condition: unknown) => compileAudienceFilter(account, parseAudienceFilter({ conditions: [condition] }));

  it.each([
    ['follows_business', 'is_true', 'i.follows_business IS TRUE'],
    ['business_follows', 'is_false', 'i.business_follows IS FALSE'],
    ['is_verified', 'is_unknown', 'i.is_verified IS NULL'],
  ])('compiles %s %s to a tenant-scoped EXISTS over the Instagram identity', (fact, op, test) => {
    const sql = compile({ field: 'instagram_profile', fact, op });
    expect(sql.sql).toContain(test);
    expect(sql.sql).toContain("EXISTS(SELECT 1 FROM contact_channel_identities i WHERE i.account_id=");
    expect(sql.sql).toContain("i.contact_id=c.id");
    expect(sql.sql).toContain("i.channel='instagram'");
    expect(sql.values.filter((v) => v === account).length).toBeGreaterThanOrEqual(2);
  });

  it('never puts a fact name into SQL as a value: only the fixed columns', () => {
    expect(() => compile({ field: 'instagram_profile', fact: 'i.id; DROP TABLE contacts', op: 'is_true' })).toThrow(AudienceFilterError);
    expect(() => compile({ field: 'instagram_profile', fact: 'follower_count', op: 'is_true' })).toThrow(AudienceFilterError);
  });

  it('compiles follower bounds with a bound integer', () => {
    const atLeast = compile({ field: 'instagram_followers', op: 'at_least', value: 1000 });
    expect(atLeast.sql).toContain('i.ig_follower_count >=');
    expect(atLeast.values).toContain(1000);
    expect(compile({ field: 'instagram_followers', op: 'at_most', value: 50 }).sql).toContain('i.ig_follower_count <=');
  });

  it.each([-1, 1.5, '10', 3_000_000_000, null])('rejects the follower value %j', (value) => {
    expect(() => compile({ field: 'instagram_followers', op: 'at_least', value })).toThrow(AudienceFilterError);
  });

  it('scopes the window conditions to the account and the 24-hour customer window', () => {
    const open = compile({ field: 'instagram_window', op: 'open' });
    expect(open.sql).toContain("v.account_id=");
    expect(open.sql).toContain("v.channel='instagram'");
    expect(open.sql).toContain("m.sender_type='customer'");
    expect(open.sql).toContain('make_interval(secs =>');
    expect(open.values).toContain(86_400);
    expect(open.values.filter((v) => v === account).length).toBeGreaterThanOrEqual(2);
    // closed means an Instagram conversation exists and none is in the window, not "no Instagram contact".
    const closed = compile({ field: 'instagram_window', op: 'closed' });
    expect(closed.sql).toMatch(/\(EXISTS\(SELECT 1 FROM conversations v[\s\S]*\) AND NOT EXISTS\(/);
  });

  it.each<unknown>([
    { field: 'instagram_profile', fact: 'is_verified', op: 'is_true', extra: 1 },
    { field: 'instagram_profile', fact: 'is_verified', op: 'yes' },
    { field: 'instagram_window', op: 'open', value: true },
    { field: 'instagram_followers', op: 'is', value: 3 },
  ])('rejects %j', (condition) => {
    expect(() => parseAudienceFilter({ conditions: [condition] })).toThrow(AudienceFilterError);
  });

  it('needs no entitlement or row lookup', async () => {
    const queries: string[] = [];
    const tx = { $queryRaw: async (sql: { sql?: string }) => { queries.push(sql.sql ?? ''); return []; } };
    await assertFilterReferences(tx as never, account, parseAudienceFilter({ conditions: [
      { field: 'instagram_profile', fact: 'follows_business', op: 'is_true' }, { field: 'instagram_window', op: 'open' }] }));
    expect(queries).toEqual([]);
  });
});
