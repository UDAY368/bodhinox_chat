import { afterEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_EVENTS } from '@/lib/inbox/notify';
import { emailDigestAvailable, mergePreferences, NotificationPreferenceError, parsePreferenceUpdate } from './preferences';

describe('mergePreferences', () => {
  it('lists every event, stored values over in-app-only defaults', () => {
    const merged = mergePreferences([{ event: 'mention', in_app: false, email: true }, { event: 'retired_event', in_app: true, email: true }]);
    expect(merged.map((p) => p.event)).toEqual([...NOTIFICATION_EVENTS]);
    expect(merged.find((p) => p.event === 'mention')).toEqual({ event: 'mention', in_app: false, email: true });
    expect(merged.find((p) => p.event === 'sla_breach')).toEqual({ event: 'sla_breach', in_app: true, email: false });
  });
});

describe('parsePreferenceUpdate', () => {
  it('accepts known events with boolean switches', () => {
    expect(parsePreferenceUpdate({ preferences: [{ event: 'campaign_finished', in_app: true, email: true }] }))
      .toEqual([{ event: 'campaign_finished', in_app: true, email: true }]);
  });

  it.each([
    null,
    {},
    { preferences: [] },
    { preferences: [{ event: 'everything', in_app: true, email: true }] },
    { preferences: [{ event: 'mention', in_app: 'yes', email: true }] },
    { preferences: [{ event: 'mention', in_app: true }] },
    { preferences: [{ event: 'mention', in_app: true, email: true, user_id: 'someone-else' }] },
    { preferences: [{ event: 'mention', in_app: true, email: true }, { event: 'mention', in_app: false, email: false }] },
    { preferences: Array.from({ length: NOTIFICATION_EVENTS.length + 1 }, () => ({ event: 'mention', in_app: true, email: true })) },
  ])('rejects %j', (body) => {
    expect(() => parsePreferenceUpdate(body)).toThrow(NotificationPreferenceError);
  });
});

describe('emailDigestAvailable', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it('needs SMTP, a sender and an app URL', () => {
    process.env.SMTP_URL = 'smtp://x';
    process.env.AUTH_EMAIL_FROM = 'a@b.c';
    process.env.APP_URL = 'https://app.example.test';
    expect(emailDigestAvailable()).toBe(true);
    delete process.env.SMTP_URL;
    expect(emailDigestAvailable()).toBe(false);
  });
});
