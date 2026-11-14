// Customer-file hashing (Meta's normalisation) and the audience request checks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashEmail, hashPhone, parseAudienceCreateInput } from './audiences';
import { adSetForm, createLookalikeAudience, replaceAudienceUsers } from './graph';

const ID = '33333333-3333-4333-8333-333333333333';

describe('hashing', () => {
  it("matches Meta's documented SHA-256 examples", () => {
    // developers.facebook.com, Customer File Custom Audiences, "Hashing".
    expect(hashEmail('mary@example.com')).toBe('f1904cf1a9d73a55fa5de0ac823c4403ded71afd4c3248d00bdcd0866552bb79');
    expect(hashPhone('15559876543')).toBe('1ef970831d7963307784fa8688e8fce101a15685d62aa765fed23f3a2c576a4e');
  });

  it('normalises before hashing: phones to digits, emails trimmed and lower-cased', () => {
    expect(hashPhone('+1 (555) 987-6543')).toBe(hashPhone('15559876543'));
    expect(hashEmail('  Mary@Example.COM ')).toBe(hashEmail('mary@example.com'));
  });

  it('gives an empty value for missing or malformed input, never a hash of junk', () => {
    for (const bad of [null, undefined, '', '12', 'call me', '+'.repeat(3)]) expect(hashPhone(bad)).toBe('');
    for (const bad of [null, undefined, '', 'mary', 'mary@', '@example.com', 'a b@c.de']) expect(hashEmail(bad)).toBe('');
  });
});

describe('parseAudienceCreateInput', () => {
  it('accepts a customer list from a segment (auto-sync on unless turned off)', () => {
    expect(parseAudienceCreateInput({ kind: 'customer_list', adAccountId: '555', name: '  Paid   customers ', segmentId: ID }))
      .toEqual({ kind: 'customer_list', adAccountId: '555', name: 'Paid customers', segmentId: ID, autoSync: true });
    expect(parseAudienceCreateInput({ kind: 'customer_list', adAccountId: '555', name: 'A', segmentId: ID, autoSync: false })?.kind)
      .toBe('customer_list');
  });

  it('accepts a lookalike of 1-10% in one country', () => {
    expect(parseAudienceCreateInput({ kind: 'lookalike', adAccountId: '555', name: 'LAL', originId: ID, country: 'in', percent: 3 }))
      .toEqual({ kind: 'lookalike', adAccountId: '555', name: 'LAL', originId: ID, country: 'IN', percent: 3 });
  });

  it('refuses anything else', () => {
    for (const bad of [
      null, {}, { kind: 'customer_list', adAccountId: 'act_555', name: 'A', segmentId: ID },
      { kind: 'customer_list', adAccountId: '555', name: '', segmentId: ID },
      { kind: 'customer_list', adAccountId: '555', name: 'x'.repeat(201), segmentId: ID },
      { kind: 'customer_list', adAccountId: '555', name: 'A', segmentId: "1' or 1=1" },
      { kind: 'lookalike', adAccountId: '555', name: 'A', originId: ID, country: 'IND', percent: 1 },
      { kind: 'lookalike', adAccountId: '555', name: 'A', originId: ID, country: 'IN', percent: 11 },
      { kind: 'lookalike', adAccountId: '555', name: 'A', originId: ID, country: 'IN', percent: 1.5 },
      { kind: 'website', adAccountId: '555', name: 'A' },
    ]) expect(parseAudienceCreateInput(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('Graph shapes', () => {
  afterEach(() => vi.unstubAllGlobals());

  const capture = () => {
    const calls: { url: string; body: URLSearchParams; auth: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: new URLSearchParams(String(init.body)), auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ id: '9001', num_received: 2, num_invalid_entries: 0 }), { status: 200 });
    }));
    return calls;
  };

  it('replace uploads [PHONE, EMAIL] rows in a session; the token stays in the header', async () => {
    const calls = capture();
    const result = await replaceAudienceUsers('77', 'tok', { sessionId: 42, batch: 1, last: true, estimatedTotal: 2 }, [['a'.repeat(64), ''], ['', 'b'.repeat(64)]]);
    expect(result).toEqual({ received: 2, invalid: 0 });
    expect(calls[0].url).toMatch(/\/v27\.0\/77\/usersreplace$/);
    expect(calls[0].url).not.toContain('tok');
    expect(calls[0].auth).toBe('Bearer tok');
    expect(JSON.parse(calls[0].body.get('payload')!)).toEqual({ schema: ['PHONE', 'EMAIL'], data: [['a'.repeat(64), ''], ['', 'b'.repeat(64)]] });
    expect(JSON.parse(calls[0].body.get('session')!)).toEqual({ session_id: 42, batch_seq: 1, last_batch_flag: true, estimated_num_total: 2 });
  });

  it('a lookalike names its source and ratio', async () => {
    const calls = capture();
    await createLookalikeAudience('555', 'tok', { name: 'LAL', originAudienceId: '77', country: 'IN', percent: 2 });
    expect(calls[0].url).toMatch(/act_555\/customaudiences$/);
    expect(calls[0].body.get('subtype')).toBe('LOOKALIKE');
    expect(calls[0].body.get('origin_audience_id')).toBe('77');
    expect(JSON.parse(calls[0].body.get('lookalike_spec')!)).toEqual({ country: 'IN', ratio: 0.02 });
  });

  it('an ad set includes and excludes audiences by id', () => {
    const form = adSetForm({
      name: 'S', campaignId: '1', kind: 'whatsapp', pageId: '2', dailyBudgetMinor: 100, startTime: 'x', endTime: null,
      countries: ['IN'], ageMin: 18, ageMax: 65, genders: [], whatsappNumber: null, status: 'PAUSED',
      audienceIds: ['11'], excludedAudienceIds: ['22'],
    });
    const targeting = JSON.parse(form.targeting);
    expect(targeting.custom_audiences).toEqual([{ id: '11' }]);
    expect(targeting.excluded_custom_audiences).toEqual([{ id: '22' }]);
    expect(() => adSetForm({ ...JSON.parse('{}'), name: 'S', campaignId: '1', kind: 'website', pageId: '2', dailyBudgetMinor: 1,
      startTime: 'x', endTime: null, countries: ['IN'], ageMin: 18, ageMax: 65, genders: [], whatsappNumber: null, status: 'PAUSED',
      audienceIds: ['1; DROP'] })).toThrow();
  });
});
