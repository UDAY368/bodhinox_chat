import { describe, expect, it } from 'vitest';

import { copyName, customRangeIssue, deviceToday, fileStem, latestToday, parseSavedReport, parseSnapshot, SAVED_REPORT_NAME_MAX } from './saved-report-shape';

const valid = { name: '  Weekly   support ', metrics: ['resolved', 'new'], group: 'day', channel: 'whatsapp', preset: '7d', format: 'pdf' };

describe('saved report definitions', () => {
  it('normalises a valid definition: trimmed name, metrics in a fixed order, defaults', () => {
    expect(parseSavedReport(valid)).toEqual({ ok: true, value: {
      name: 'Weekly support', metrics: ['new', 'resolved'], group: 'day', channel: 'whatsapp',
      range: { preset: '7d', from: null, to: null }, format: 'pdf',
    } });
    const minimal = parseSavedReport({ name: 'A', metrics: ['messages'], group: 'agent', preset: '30d' });
    expect(minimal).toMatchObject({ ok: true, value: { channel: 'all', format: 'csv' } });
  });

  it.each([
    [{ ...valid, name: '' }, 'name'],
    [{ ...valid, name: 'x'.repeat(SAVED_REPORT_NAME_MAX + 1) }, 'name'],
    [{ ...valid, name: 42 }, 'name'],
    [{ ...valid, metrics: [] }, 'metrics'],
    [{ ...valid, metrics: ['new', 'new'] }, 'metrics'],
    [{ ...valid, metrics: ['csat'] }, 'metrics'],
    [{ ...valid, metrics: 'new' }, 'metrics'],
    [{ ...valid, group: 'contact' }, 'group'],
    [{ ...valid, channel: 'sms' }, 'channel'],
    [{ ...valid, preset: 'forever' }, 'range'],
    [{ ...valid, format: 'xlsx' }, 'format'],
    [{ ...valid, preset: 'custom' }, 'dates'],
    [{ ...valid, preset: 'custom', from: '2026-02-30', to: '2026-03-01' }, 'dates'],
    [{ ...valid, preset: 'custom', from: '2026-03-02', to: '2026-03-01' }, 'dates'],
    [{ ...valid, preset: 'custom', from: '2024-01-01', to: '2026-01-01' }, 'dates'],
  ])('refuses %j (%s)', (input, issue) => {
    expect(parseSavedReport(input)).toEqual({ ok: false, issue });
  });

  it('keeps custom days only for a custom range, and refuses non-objects', () => {
    expect(parseSavedReport({ ...valid, preset: 'custom', from: '2026-10-01', to: '2026-10-31' }))
      .toMatchObject({ ok: true, value: { range: { preset: 'custom', from: '2026-10-01', to: '2026-10-31' } } });
    expect(parseSavedReport({ ...valid, from: '2026-10-01', to: '2026-10-31' }))
      .toMatchObject({ ok: true, value: { range: { preset: '7d', from: null, to: null } } });
    expect(parseSavedReport(null)).toEqual({ ok: false, issue: 'name' });
    expect(parseSavedReport([valid])).toEqual({ ok: false, issue: 'name' });
  });

  it('refuses a custom range that ends after the latest today anywhere, on the server', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const body = { ...valid, preset: 'custom', from: '2026-11-01' };
    // 12:00 UTC is already 14 Nov in UTC+14, so the 14th is allowed; the 15th is not.
    expect(parseSavedReport({ ...body, to: '2026-11-14' }, now)).toMatchObject({ ok: true });
    expect(parseSavedReport({ ...body, to: '2026-11-15' }, now)).toEqual({ ok: false, issue: 'dates' });
    expect(latestToday(now)).toBe('2026-11-14');
    expect(deviceToday(new Date(2026, 10, 13, 23, 59))).toBe('2026-11-13');
  });

  it('explains why a custom range is refused', () => {
    expect(customRangeIssue('', '2026-01-01')).toBe('missing');
    expect(customRangeIssue('2026-01-02', '2026-01-01')).toBe('order');
    expect(customRangeIssue('2026-01-01', '2026-12-01', '2026-11-13')).toBe('future');
    expect(customRangeIssue('2025-01-01', '2026-01-02')).toBe('too_long');
    expect(customRangeIssue('2025-01-02', '2026-01-02')).toBeNull();
  });

  it('reads back only a valid run snapshot', () => {
    expect(parseSnapshot({ name: 'R', metrics: ['failed', 'new'], group: 'label', channel: 'all' }))
      .toEqual({ name: 'R', metrics: ['new', 'failed'], group: 'label', channel: 'all' });
    expect(parseSnapshot({ name: 'R', metrics: ['new'], group: 'label' })).toBeNull();
    expect(parseSnapshot({ name: '', metrics: ['new'], group: 'day', channel: 'all' })).toBeNull();
    expect(parseSnapshot('report')).toBeNull();
  });

  it('names copies without colliding and within the limit', () => {
    expect(copyName('Weekly', ['Weekly'])).toBe('Weekly copy');
    expect(copyName('Weekly', ['Weekly', 'weekly COPY'])).toBe('Weekly copy 2');
    const long = 'x'.repeat(SAVED_REPORT_NAME_MAX);
    expect(copyName(long, [long]).length).toBeLessThanOrEqual(SAVED_REPORT_NAME_MAX);
  });

  it('makes safe file names', () => {
    expect(fileStem('Agent performance / Q4 "final"')).toBe('agent-performance-q4-final');
    expect(fileStem('주간 보고서')).toBe('report');
  });
});
