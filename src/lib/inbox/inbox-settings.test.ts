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

  describe('the Instagram away switch (Stage 2)', () => {
    it('is left out when the body omits it, so older clients keep the stored value', () => {
      expect(parseInboxSettingsInput(base)).not.toHaveProperty('instagram_away_message_enabled');
    });
    it('passes a boolean through, independent of the WhatsApp switch', () => {
      expect(parseInboxSettingsInput({ ...base, away_message_enabled: false, instagram_away_message_enabled: true }))
        .toMatchObject({ away_message_enabled: false, instagram_away_message_enabled: true });
      expect(parseInboxSettingsInput({ ...base, instagram_away_message_enabled: false }))
        .toMatchObject({ instagram_away_message_enabled: false });
    });
    it.each([
      [{ ...base, instagram_away_message_enabled: 'yes' }],
      [{ ...base, away_message_enabled: false, away_message: '', instagram_away_message_enabled: true }],
      [{ ...base, away_message_enabled: false, away_message: null, instagram_away_message_enabled: true }],
      // 400 Korean characters fit the shared 1024-character limit but not Instagram's 1000 bytes.
      [{ ...base, away_message: '한'.repeat(400), instagram_away_message_enabled: true }],
    ])('refuses %j (it needs a boolean and the away text)', (body) => expect(code(body)).toBe('invalid_away_message'));
  });

  describe('Stage 5 pause, assignment and visibility settings', () => {
    it('leaves each one out when the body omits it, so older clients keep the stored values', () => {
      const parsed = parseInboxSettingsInput(base);
      for (const key of ['agent_reply_pause_minutes', 'auto_assign_mode', 'agent_visibility']) expect(parsed).not.toHaveProperty(key);
    });
    it('passes valid values through, with null meaning "until resumed"', () => {
      expect(parseInboxSettingsInput({ ...base, agent_reply_pause_minutes: 60, auto_assign_mode: 'basic', agent_visibility: 'assigned_or_team' }))
        .toMatchObject({ agent_reply_pause_minutes: 60, auto_assign_mode: 'basic', agent_visibility: 'assigned_or_team' });
      expect(parseInboxSettingsInput({ ...base, agent_reply_pause_minutes: null, auto_assign_mode: 'off', agent_visibility: 'all' }))
        .toMatchObject({ agent_reply_pause_minutes: null, auto_assign_mode: 'off', agent_visibility: 'all' });
      expect(parseInboxSettingsInput({ ...base, agent_reply_pause_minutes: 10080 })).toMatchObject({ agent_reply_pause_minutes: 10080 });
    });
    it.each([
      [{ ...base, agent_reply_pause_minutes: 0 }, 'invalid_pause'],
      [{ ...base, agent_reply_pause_minutes: 10081 }, 'invalid_pause'],
      [{ ...base, agent_reply_pause_minutes: 1.5 }, 'invalid_pause'],
      [{ ...base, agent_reply_pause_minutes: '60' }, 'invalid_pause'],
      [{ ...base, auto_assign_mode: 'smart' }, 'invalid_assignment'],
      [{ ...base, auto_assign_mode: null }, 'invalid_assignment'],
      [{ ...base, agent_visibility: 'team' }, 'invalid_visibility'],
      [{ ...base, agent_visibility: '' }, 'invalid_visibility'],
    ])('rejects %j with %s', (body, expected) => expect(code(body)).toBe(expected));
  });
});
