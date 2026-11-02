import { describe, expect, it } from 'vitest';
import { InboxSettingsError, parseInboxSettingsInput } from './inbox-settings';

const base = {
  timezone: 'Asia/Kolkata',
  working_hours: { mon: [{ start: '13:00', end: '18:00' }, { start: '09:00', end: '12:00' }] },
  away_message_enabled: true,
  away_message: '  We are closed, back at 9.  ',
  auto_resolve_after_hours: 24,
  sla_first_response_minutes: 15,
};

const code = (body: unknown) => {
  try { parseInboxSettingsInput(body); } catch (error) { return error instanceof InboxSettingsError ? error.code : 'other'; }
  return null;
};

describe('parseInboxSettingsInput', () => {
  it('normalises a valid body', () => {
    expect(parseInboxSettingsInput(base)).toEqual({
      ...base,
      working_hours: { mon: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }] },
      away_message: 'We are closed, back at 9.',
    });
  });
  it('treats empty limits as off and keeps a disabled away text', () => {
    expect(parseInboxSettingsInput({ ...base, away_message_enabled: false, auto_resolve_after_hours: null, sla_first_response_minutes: '' }))
      .toMatchObject({ away_message_enabled: false, away_message: 'We are closed, back at 9.', auto_resolve_after_hours: null, sla_first_response_minutes: null });
  });
  it.each([
    [{ ...base, timezone: 'Mars/Base' }, 'invalid_timezone'],
    [null, 'invalid_timezone'],
    [{ ...base, working_hours: { mon: [{ start: '10:00', end: '09:00' }] } }, 'invalid_working_hours'],
    [{ ...base, working_hours: { funday: [] } }, 'invalid_working_hours'],
    [{ ...base, away_message: '   ' }, 'invalid_away_message'],
    [{ ...base, away_message: 'x'.repeat(1025) }, 'invalid_away_message'],
    [{ ...base, away_message_enabled: 'yes' }, 'invalid_away_message'],
    [{ ...base, auto_resolve_after_hours: 721 }, 'invalid_auto_resolve'],
    [{ ...base, auto_resolve_after_hours: '24' }, 'invalid_auto_resolve'],
    [{ ...base, sla_first_response_minutes: 0 }, 'invalid_sla'],
  ])('rejects %j with %s', (body, expected) => expect(code(body)).toBe(expected));
});
