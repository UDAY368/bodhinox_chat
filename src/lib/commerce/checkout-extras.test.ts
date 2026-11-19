import { describe, expect, it } from 'vitest';
import {
  checkExtras, customExtrasText, DEFAULT_EXTRAS_CONFIG, deliveryDateBounds, hasExtras, isCalendarDate, localToday, parseExtrasConfig, readBuyerExtras,
  type ExtrasConfig,
} from './checkout-extras';
import { csvCell } from './order-export';

const NOW = new Date('2026-12-01T10:00:00Z');

const config: ExtrasConfig = {
  note_enabled: true, gift_message_enabled: true, delivery_date_enabled: true, lead_days: 2, window_days: 10,
  slots: [{ id: 'am', label: '9am - 12pm' }, { id: 'pm', label: '2pm - 6pm' }],
  custom_fields: [
    { id: 'gift', label: 'Gift wrap', type: 'checkbox', required: false, options: [] },
    { id: 'size', label: 'Box size', type: 'select', required: true, options: ['Small', 'Large'] },
    { id: 'sign', label: 'Signature name', type: 'text', required: false, options: [] },
  ],
};

const refused = (fn: () => unknown, field: string) =>
  expect(fn).toThrow(expect.objectContaining({ code: 'extras_invalid', detail: { field } }));

describe('delivery date bounds', () => {
  it('start after the lead days and run for the window', () => {
    expect(deliveryDateBounds(NOW, 2, 10)).toEqual({ min: '2026-12-03', max: '2026-12-13' });
    expect(deliveryDateBounds(NOW, 0, 1)).toEqual({ min: '2026-12-01', max: '2026-12-02' });
    expect(deliveryDateBounds(new Date('2026-12-30T23:59:00Z'), 3, 2, 'UTC')).toEqual({ min: '2027-01-02', max: '2027-01-04' });
  });
  it('counts "today" in the workspace timezone, also around midnight', () => {
    // 1 am IST on 2 Dec is still 1 Dec in UTC (19:30Z): an Indian shop counts from 2 Dec.
    const oneAmIst = new Date('2026-12-01T19:30:00Z');
    expect(localToday(oneAmIst, 'Asia/Kolkata')).toBe('2026-12-02');
    expect(localToday(oneAmIst, 'UTC')).toBe('2026-12-01');
    expect(deliveryDateBounds(oneAmIst, 1, 3, 'Asia/Kolkata')).toEqual({ min: '2026-12-03', max: '2026-12-06' });
    expect(deliveryDateBounds(oneAmIst, 1, 3, 'UTC')).toEqual({ min: '2026-12-02', max: '2026-12-05' });
    // One minute before and after local midnight (18:30Z), and a zone behind UTC.
    expect(localToday(new Date('2026-12-01T18:29:00Z'), 'Asia/Kolkata')).toBe('2026-12-01');
    expect(localToday(new Date('2026-12-01T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-12-02');
    expect(localToday(new Date('2026-12-01T03:00:00Z'), 'America/New_York')).toBe('2026-11-30');
    // A zone name that does not exist reads as the fallback zone; the default is India time.
    expect(localToday(oneAmIst, 'Not/AZone')).toBe('2026-12-02');
    expect(deliveryDateBounds(oneAmIst, 0, 1).min).toBe('2026-12-02');
  });
  it('checks a picked date against the shop own today', () => {
    const cfg = { ...config, lead_days: 1, window_days: 3, timezone: 'Asia/Kolkata' };
    const oneAmIst = new Date('2026-12-01T19:30:00Z');
    expect(checkExtras(cfg, { delivery_date: '2026-12-03', slot_id: 'am', custom: { size: 'Small' } }, oneAmIst, { complete: true }).extras.delivery_date).toBe('2026-12-03');
    refused(() => checkExtras(cfg, { delivery_date: '2026-12-02', slot_id: 'am', custom: { size: 'Small' } }, oneAmIst, { complete: true }), 'delivery_date');
    expect(checkExtras({ ...cfg, timezone: 'UTC' }, { delivery_date: '2026-12-02', slot_id: 'am', custom: { size: 'Small' } }, oneAmIst, { complete: true }).extras.delivery_date).toBe('2026-12-02');
  });
  it('knows a real calendar date', () => {
    expect(isCalendarDate('2026-12-03')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-1-3')).toBe(false);
    expect(isCalendarDate('tomorrow')).toBe(false);
  });
});

describe('delivery date and slot validation', () => {
  const ok = { delivery_date: '2026-12-05', slot_id: 'pm', custom: { size: 'Large' } };
  it('accepts a date in range with a listed slot and keeps the slot label', () => {
    const { extras, input } = checkExtras(config, ok, NOW, { complete: true });
    expect(extras.delivery_date).toBe('2026-12-05');
    expect(extras.delivery_slot).toBe('2pm - 6pm');
    expect(input.slot_id).toBe('pm');
  });
  it('refuses a date before the lead days, after the window and a date that does not exist', () => {
    refused(() => checkExtras(config, { ...ok, delivery_date: '2026-12-02' }, NOW, { complete: true }), 'delivery_date');
    refused(() => checkExtras(config, { ...ok, delivery_date: '2026-12-14' }, NOW, { complete: true }), 'delivery_date');
    refused(() => checkExtras(config, { ...ok, delivery_date: '2026-13-01' }, NOW, { complete: true }), 'delivery_date');
  });
  it('accepts the first and the last allowed day', () => {
    expect(checkExtras(config, { ...ok, delivery_date: '2026-12-03' }, NOW, { complete: true }).extras.delivery_date).toBe('2026-12-03');
    expect(checkExtras(config, { ...ok, delivery_date: '2026-12-13' }, NOW, { complete: true }).extras.delivery_date).toBe('2026-12-13');
  });
  it('refuses a slot the shop does not have', () => {
    refused(() => checkExtras(config, { ...ok, slot_id: 'night' }, NOW, { complete: true }), 'slot_id');
  });
  it('needs the date and the slot only when placing, and not for a cart of downloads', () => {
    expect(() => checkExtras(config, { custom: { size: 'Small' } }, NOW, { complete: false })).not.toThrow();
    refused(() => checkExtras(config, { custom: { size: 'Small' } }, NOW, { complete: true }), 'delivery_date');
    refused(() => checkExtras(config, { delivery_date: '2026-12-05', custom: { size: 'Small' } }, NOW, { complete: true }), 'slot_id');
    expect(checkExtras(config, { delivery_date: '2026-12-09', slot_id: 'am', custom: { size: 'Small' } }, NOW, { complete: true, physical: false })
      .extras.delivery_date).toBeNull();
    expect(() => checkExtras(config, { custom: { size: 'Small' } }, NOW, { complete: true, physical: false })).not.toThrow();
  });
  it('refuses a date or slot when the shop offers no delivery date', () => {
    const off = { ...config, delivery_date_enabled: false };
    refused(() => checkExtras(off, { delivery_date: '2026-12-05' }, NOW, { complete: false }), 'delivery_date');
    refused(() => checkExtras(off, { slot_id: 'am' }, NOW, { complete: false }), 'delivery_date');
  });
});

describe('note and gift message', () => {
  it('keeps clean text, drops control characters and refuses too long text', () => {
    const { extras } = checkExtras(config, { note: '  leave\u0000 at\ngate  ', gift_message: 'Happy birthday' }, NOW, { complete: false });
    expect(extras.note).toBe('leave  at gate');
    expect(extras.gift_message).toBe('Happy birthday');
    refused(() => checkExtras(config, { note: 'x'.repeat(301) }, NOW, { complete: false }), 'note');
    refused(() => checkExtras(config, { gift_message: 'x'.repeat(201) }, NOW, { complete: false }), 'gift_message');
    refused(() => checkExtras(config, { note: 42 }, NOW, { complete: false }), 'note');
  });
  it('refuses what the shop does not offer', () => {
    refused(() => checkExtras({ ...config, note_enabled: false }, { note: 'hi' }, NOW, { complete: false }), 'note');
    refused(() => checkExtras({ ...config, gift_message_enabled: false }, { gift_message: 'hi' }, NOW, { complete: false }), 'gift_message');
  });
  it('refuses unknown properties', () => {
    refused(() => checkExtras(config, { total_minor: 1 }, NOW, { complete: false }), 'extras');
  });
});

describe('custom field validation', () => {
  it('stores answers with their labels, in the shop order', () => {
    const { extras, input } = checkExtras(config, { delivery_date: '2026-12-05', slot_id: 'am', custom: { sign: 'Asha', size: 'Large', gift: true } }, NOW, { complete: true });
    expect(extras.custom).toEqual([{ label: 'Gift wrap', value: 'yes' }, { label: 'Box size', value: 'Large' }, { label: 'Signature name', value: 'Asha' }]);
    expect(input.custom).toEqual({ gift: true, size: 'Large', sign: 'Asha' });
  });
  it('enforces required fields only when placing', () => {
    expect(() => checkExtras(config, {}, NOW, { complete: false })).not.toThrow();
    refused(() => checkExtras(config, { delivery_date: '2026-12-05', slot_id: 'am' }, NOW, { complete: true }), 'custom.size');
  });
  it('refuses a choice that is not listed, a wrong type, an unknown field and a long answer', () => {
    refused(() => checkExtras(config, { custom: { size: 'Huge' } }, NOW, { complete: false }), 'custom.size');
    refused(() => checkExtras(config, { custom: { gift: 'yes' } }, NOW, { complete: false }), 'custom.gift');
    refused(() => checkExtras(config, { custom: { other: 'x' } }, NOW, { complete: false }), 'custom');
    refused(() => checkExtras(config, { custom: { sign: 'x'.repeat(201) } }, NOW, { complete: false }), 'custom.sign');
  });
  it('an unticked required box does not count as an answer', () => {
    const cfg = { ...config, custom_fields: [{ id: 'age', label: 'I am over 18', type: 'checkbox' as const, required: true, options: [] }], delivery_date_enabled: false };
    refused(() => checkExtras(cfg, { custom: { age: false } }, NOW, { complete: true }), 'custom.age');
    expect(checkExtras(cfg, { custom: { age: true } }, NOW, { complete: true }).extras.custom).toEqual([{ label: 'I am over 18', value: 'yes' }]);
  });
});

describe('parseExtrasConfig (admin)', () => {
  const base = { ...config };
  it('accepts a valid configuration and the defaults', () => {
    expect(parseExtrasConfig(base)).toEqual(base);
    expect(parseExtrasConfig(DEFAULT_EXTRAS_CONFIG)).toEqual(DEFAULT_EXTRAS_CONFIG);
    expect(hasExtras(DEFAULT_EXTRAS_CONFIG)).toBe(false);
    expect(hasExtras(base)).toBe(true);
  });
  it.each([
    ['too many slots', { ...base, slots: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, label: 'x' })) }],
    ['duplicate slot ids', { ...base, slots: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }],
    ['a slot without a label', { ...base, slots: [{ id: 'a', label: ' ' }] }],
    ['too many custom fields', { ...base, custom_fields: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, label: 'x', type: 'text', required: false })) }],
    ['a select with one option', { ...base, custom_fields: [{ id: 'a', label: 'x', type: 'select', required: false, options: ['one'] }] }],
    ['a select with repeated options', { ...base, custom_fields: [{ id: 'a', label: 'x', type: 'select', required: false, options: ['one', 'one'] }] }],
    ['an unknown field type', { ...base, custom_fields: [{ id: 'a', label: 'x', type: 'file', required: false }] }],
    ['an id with capitals', { ...base, custom_fields: [{ id: 'Gift', label: 'x', type: 'text', required: false }] }],
    ['lead days out of range', { ...base, lead_days: 61 }],
    ['a zero window', { ...base, window_days: 0 }],
    ['a label over the cap', { ...base, custom_fields: [{ id: 'a', label: 'x'.repeat(61), type: 'text', required: false }] }],
    ['a non-boolean switch', { ...base, note_enabled: 'yes' }],
  ])('refuses %s', (_name, body) => {
    expect(() => parseExtrasConfig(body)).toThrow(expect.objectContaining({ code: 'extras_invalid' }));
  });
});

describe('the stored snapshot and the CSV export', () => {
  it('reads defensively and returns null when nothing is stored', () => {
    expect(readBuyerExtras(null)).toBeNull();
    expect(readBuyerExtras([])).toBeNull();
    expect(readBuyerExtras({ note: '', custom: 'x' })).toBeNull();
    expect(readBuyerExtras({ note: 'hi', custom: [{ label: 'a', value: 'b' }, { label: 1 }] })).toEqual({
      note: 'hi', gift_message: null, delivery_date: null, delivery_slot: null, custom: [{ label: 'a', value: 'b' }],
    });
  });
  it('a buyer-typed formula in an extras cell is neutralised by the export guard', () => {
    const e = readBuyerExtras({ note: '=HYPERLINK("http://evil")', custom: [{ label: 'Name', value: '@SUM(A1)' }] });
    expect(csvCell(e?.note)).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell(customExtrasText(e))).toBe('"Name: @SUM(A1)"');
    expect(csvCell('+91 99999')).toBe('"\'+91 99999"');
  });
});
