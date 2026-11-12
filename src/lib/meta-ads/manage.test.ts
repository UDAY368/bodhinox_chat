import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdObject, listAdObjects, MetaGraphInputError, updateAdObject, type MetaAdObject } from './graph';
import { changeFields, exceedsCap, parseAdChangeInput, parseBudgetCap, showsValue } from './manage';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const DAY = 86_400_000;

describe('parseAdChangeInput', () => {
  it('accepts the five fields with Meta-ready values', () => {
    expect(parseAdChangeInput({ objectId: '120', field: 'status', value: 'PAUSED' }, NOW))
      .toEqual({ objectId: '120', field: 'status', value: 'PAUSED' });
    expect(parseAdChangeInput({ objectId: '120', field: 'daily_budget', value: 50000 }, NOW))
      .toEqual({ objectId: '120', field: 'daily_budget', value: '50000' });
    expect(parseAdChangeInput({ objectId: '120', field: 'lifetime_budget', value: '900000' }, NOW)?.value).toBe('900000');
    expect(parseAdChangeInput({ objectId: '120', field: 'end_time', value: '2026-12-01T00:00:00+05:30' }, NOW)?.value)
      .toBe('2026-11-30T18:30:00.000Z');
    expect(parseAdChangeInput({ objectId: '120', field: 'name', value: '  Diwali sale  ' }, NOW)?.value).toBe('Diwali sale');
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      null, 'x', {},
      { objectId: 'act_1', field: 'status', value: 'PAUSED' },
      { objectId: '../me', field: 'status', value: 'PAUSED' },
      { objectId: '1', field: 'bid_amount', value: '1' },
      { objectId: '1', field: 'status', value: 'ARCHIVED' },
      { objectId: '1', field: 'status', value: 'DELETED' },
      { objectId: '1', field: 'daily_budget', value: 0 },
      { objectId: '1', field: 'daily_budget', value: -5 },
      { objectId: '1', field: 'daily_budget', value: 12.5 },
      { objectId: '1', field: 'daily_budget', value: '1e6' },
      { objectId: '1', field: 'daily_budget', value: '1000000000000000' },
      { objectId: '1', field: 'end_time', value: 'tomorrow' },
      { objectId: '1', field: 'end_time', value: new Date(NOW + 10 * 60_000).toISOString() },
      { objectId: '1', field: 'end_time', value: new Date(NOW + 4 * 365 * DAY).toISOString() },
      { objectId: '1', field: 'name', value: '   ' },
      { objectId: '1', field: 'name', value: 'a'.repeat(401) },
      { objectId: '1', field: 'name', value: 'bad\u0000name' },
    ];
    for (const body of bad) expect(parseAdChangeInput(body, NOW)).toBeNull();
  });
});

describe('exceedsCap', () => {
  const open = { start_time: null, end_time: null };
  it('never refuses without a cap', () => {
    expect(exceedsCap(null, { daily: 10 ** 12, lifetime: 10 ** 12 }, open, NOW)).toBe(false);
  });
  it('compares daily budgets with the cap', () => {
    expect(exceedsCap(50000, { daily: 50000, lifetime: null }, open, NOW)).toBe(false);
    expect(exceedsCap(50000, { daily: 50001, lifetime: null }, open, NOW)).toBe(true);
  });
  it('spreads a lifetime budget over its remaining days, and refuses one with no end date', () => {
    const tenDays = { start_time: null, end_time: new Date(NOW + 10 * DAY) };
    expect(exceedsCap(1000, { daily: null, lifetime: 10_000 }, tenDays, NOW)).toBe(false);
    expect(exceedsCap(1000, { daily: null, lifetime: 10_001 }, tenDays, NOW)).toBe(true);
    // Starts later: only the days it actually runs count.
    const later = { start_time: new Date(NOW + 5 * DAY), end_time: new Date(NOW + 10 * DAY) };
    expect(exceedsCap(1000, { daily: null, lifetime: 6000 }, later, NOW)).toBe(true);
    expect(exceedsCap(1000, { daily: null, lifetime: 10 }, open, NOW)).toBe(true);
  });
});

describe('showsValue and changeFields', () => {
  const object: MetaAdObject = {
    level: 'adset', id: '1', campaignId: '2', adsetId: '1', name: 'Set', status: 'PAUSED', effectiveStatus: 'PAUSED',
    objective: null, dailyBudgetMinor: 50000, lifetimeBudgetMinor: null, startTime: null, endTime: '2026-12-01T00:00:30.000Z',
  };
  it('reads each field back the way Meta stores it', () => {
    expect(showsValue(object, 'status', 'PAUSED')).toBe(true);
    expect(showsValue(object, 'status', 'ACTIVE')).toBe(false);
    expect(showsValue(object, 'daily_budget', '50000')).toBe(true);
    expect(showsValue(object, 'daily_budget', '60000')).toBe(false);
    expect(showsValue(object, 'lifetime_budget', '50000')).toBe(false);
    expect(showsValue(object, 'end_time', '2026-12-01T00:00:00.000Z')).toBe(true);
    expect(showsValue(object, 'end_time', '2026-12-01T00:05:00.000Z')).toBe(false);
    expect(showsValue(object, 'name', 'Set')).toBe(true);
  });
  it('sends one Graph field per change', () => {
    expect(changeFields('daily_budget', '50000')).toEqual({ daily_budget: '50000' });
    expect(changeFields('status', 'ACTIVE')).toEqual({ status: 'ACTIVE' });
  });
});

describe('parseBudgetCap', () => {
  it('accepts a positive whole amount or null, nothing else', () => {
    expect(parseBudgetCap({ maxDailyBudget: 50000 })).toBe(50000);
    expect(parseBudgetCap({ maxDailyBudget: null })).toBeNull();
    for (const body of [null, {}, { maxDailyBudget: 0 }, { maxDailyBudget: 1.5 }, { maxDailyBudget: '500' }, { maxDailyBudget: 1e16 }]) {
      expect(parseBudgetCap(body)).toBeUndefined();
    }
  });
});

describe('ad management Graph calls', () => {
  const TOKEN = 'EAAB-secret-token-value';
  const fetchMock = vi.fn();
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists campaigns, ad sets and ads with budgets in minor units', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/campaigns')) return json({ data: [{ id: '10', name: 'Camp', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000', lifetime_budget: '0' }] });
      if (path.endsWith('/adsets')) return json({ data: [{ id: '20', name: 'Set', campaign_id: '10', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED', end_time: '2026-12-01T00:00:00+0530' }, { id: 'bad' }] });
      return json({ data: [{ id: '30', name: 'Ad', campaign_id: '10', adset_id: '20', status: 'ACTIVE', effective_status: 'ADSET_PAUSED' }] });
    });
    const objects = await listAdObjects('99', TOKEN);
    expect(objects).toEqual([
      expect.objectContaining({ level: 'campaign', id: '10', campaignId: '10', dailyBudgetMinor: 50000, lifetimeBudgetMinor: null }),
      expect.objectContaining({ level: 'adset', id: '20', campaignId: '10', adsetId: '20', endTime: '2026-11-30T18:30:00.000Z' }),
      expect.objectContaining({ level: 'ad', id: '30', adsetId: '20', effectiveStatus: 'ADSET_PAUSED' }),
    ]);
    for (const [url, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(new URL(url).pathname).toMatch(/\/act_99\/(campaigns|adsets|ads)$/);
      expect(url).not.toContain(TOKEN);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('updates one object with a form post and reads it back', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await expect(updateAdObject('20', TOKEN, { daily_budget: '60000' })).resolves.toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toMatch(/\/20$/);
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('daily_budget=60000');

    fetchMock.mockResolvedValueOnce(json({ id: '20', status: 'PAUSED', daily_budget: '60000' }));
    expect(await getAdObject('20', 'adset', TOKEN)).toMatchObject({ id: '20', dailyBudgetMinor: 60000 });
  });

  it('refuses ids that could change the request path, before any call', async () => {
    await expect(updateAdObject('20/../me', TOKEN, { status: 'PAUSED' })).rejects.toBeInstanceOf(MetaGraphInputError);
    await expect(listAdObjects('act_1', TOKEN)).rejects.toBeInstanceOf(MetaGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
