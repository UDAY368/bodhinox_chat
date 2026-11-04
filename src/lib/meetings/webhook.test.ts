import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isZoomEvent, minimiseZoomEvent, parseMinimalZoomEvent, urlValidationResponse, verifyZoomSignature, ZOOM_SIGNATURE_SKEW_SECONDS,
} from './webhook';

const SECRET = 'zoom-secret-token';
const sign = (raw: string, ts: string, secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
const NOW = 1_762_000_000_000;
const TS = String(NOW / 1000);

describe('verifyZoomSignature', () => {
  const raw = '{"event":"meeting.started","payload":{"account_id":"abc"},"event_ts":1762000000000}';

  it('accepts Zoom\'s v0 scheme over the raw body', () => {
    expect(verifyZoomSignature(raw, TS, sign(raw, TS), SECRET, NOW)).toBe(true);
  });

  it('refuses a changed body, another secret, or a missing or malformed header', () => {
    expect(verifyZoomSignature(`${raw} `, TS, sign(raw, TS), SECRET, NOW)).toBe(false);
    expect(verifyZoomSignature(raw, TS, sign(raw, TS, 'other'), SECRET, NOW)).toBe(false);
    expect(verifyZoomSignature(raw, null, sign(raw, TS), SECRET, NOW)).toBe(false);
    expect(verifyZoomSignature(raw, TS, null, SECRET, NOW)).toBe(false);
    expect(verifyZoomSignature(raw, TS, sign(raw, TS).replace('v0=', 'v1='), SECRET, NOW)).toBe(false);
    expect(verifyZoomSignature(raw, TS, `${sign(raw, TS)}00`, SECRET, NOW)).toBe(false);
    expect(verifyZoomSignature(raw, 'abc', sign(raw, 'abc'), SECRET, NOW)).toBe(false);
    expect(verifyZoomSignature(raw, TS, sign(raw, TS), '', NOW)).toBe(false);
  });

  it('refuses a timestamp outside the skew, either way', () => {
    const old = String(NOW / 1000 - ZOOM_SIGNATURE_SKEW_SECONDS - 1);
    const future = String(NOW / 1000 + ZOOM_SIGNATURE_SKEW_SECONDS + 1);
    expect(verifyZoomSignature(raw, old, sign(raw, old), SECRET, NOW)).toBe(false);
    expect(verifyZoomSignature(raw, future, sign(raw, future), SECRET, NOW)).toBe(false);
    const edge = String(NOW / 1000 - ZOOM_SIGNATURE_SKEW_SECONDS);
    expect(verifyZoomSignature(raw, edge, sign(raw, edge), SECRET, NOW)).toBe(true);
  });

  it('accepts a millisecond timestamp header defensively', () => {
    expect(verifyZoomSignature(raw, String(NOW), sign(raw, String(NOW)), SECRET, NOW)).toBe(true);
  });
});

describe('urlValidationResponse', () => {
  it('is hex HMAC-SHA256(secret, plainToken) (RFC 4231 case 2 vector)', () => {
    expect(urlValidationResponse('what do ya want for nothing?', 'Jefe')).toEqual({
      plainToken: 'what do ya want for nothing?',
      encryptedToken: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    });
  });
});

describe('minimiseZoomEvent', () => {
  const joined = {
    event: 'meeting.participant_joined',
    event_ts: 1762000000123,
    payload: {
      account_id: 'AcctZ_1',
      object: {
        id: 85712345678, uuid: 'abc==', host_id: 'HostUser1', topic: 'Consult · abcdefghij', start_time: '2026-11-09T10:00:00Z',
        participant: {
          user_id: '16778240', user_name: 'Asha Patel', id: 'ZoomUser9', participant_uuid: 'PUUID-1', email: 'asha@example.com',
          phone_number: '+919800000000', registrant_id: 'reg_ABC', join_time: '2026-11-09T10:02:00Z', ip_address: '203.0.113.9',
          location: 'Pune', customer_key: 'secret',
        },
      },
    },
  };

  it('keeps ids and timestamps only', () => {
    const m = minimiseZoomEvent(joined);
    expect(m).toEqual({
      event: 'meeting.participant_joined', zoomAccountId: 'AcctZ_1', meetingId: '85712345678', hostId: 'HostUser1',
      participantUserId: 'ZoomUser9', participantKey: createHash('sha256').update('PUUID-1').digest('hex'), registrantId: 'reg_ABC',
      eventTs: 1762000000123, joinTime: '2026-11-09T10:02:00.000Z', leaveTime: null,
    });
    const text = JSON.stringify(m);
    for (const pii of ['Asha', 'asha@example.com', '9800000000', '203.0.113.9', 'Pune', 'Consult', 'PUUID-1', 'secret'])
      expect(text).not.toContain(pii);
  });

  it('hashes the per-session user id when there is no participant_uuid, and drops malformed ids', () => {
    const m = minimiseZoomEvent({
      event: 'meeting.participant_left',
      payload: { account_id: 'bad account!', object: { id: 'not-numeric', host_id: 'H', participant: { user_id: '42', leave_time: 'nope' } } },
    });
    expect(m).toMatchObject({
      zoomAccountId: null, meetingId: null, participantKey: createHash('sha256').update('session:42').digest('hex'), leaveTime: null, eventTs: null,
    });
  });

  it('returns null for anything that is not an event object', () => {
    for (const body of [null, [], 'x', {}, { event: 42 }, { event: 'Bad Event' }]) expect(minimiseZoomEvent(body)).toBeNull();
  });

  it('round-trips through the job payload parser, which re-validates every field', () => {
    const m = minimiseZoomEvent(joined);
    expect(parseMinimalZoomEvent(JSON.parse(JSON.stringify(m)))).toEqual(m);
    expect(parseMinimalZoomEvent({ ...m, participantKey: 'not-a-hash', meetingId: 'x', name: 'Asha' }))
      .toMatchObject({ participantKey: null, meetingId: null });
    expect(parseMinimalZoomEvent(null)).toBeNull();
  });

  it('dates app_deauthorized by deauthorization_time when event_ts is missing', () => {
    const body = { event: 'app_deauthorized', payload: { account_id: 'AcctZ_1', user_id: 'U1', deauthorization_time: '2026-11-09T10:00:00Z' } };
    expect(minimiseZoomEvent(body)?.eventTs).toBe(Date.parse('2026-11-09T10:00:00Z'));
    expect(minimiseZoomEvent({ ...body, event_ts: 1762000000123 })?.eventTs).toBe(1762000000123);
  });

  it('knows the subscribed events', () => {
    expect(isZoomEvent('meeting.ended')).toBe(true);
    expect(isZoomEvent('app_deauthorized')).toBe(true);
    expect(isZoomEvent('meeting.created')).toBe(false);
    expect(isZoomEvent('endpoint.url_validation')).toBe(false);
  });
});
