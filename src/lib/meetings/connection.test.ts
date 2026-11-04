import { describe, expect, it } from 'vitest';
import { missingZoomScopes, pkceChallenge, readZoomState, signZoomState, type ZoomOAuthState } from './connection';
import { meetingTopic, newMeetingRef } from './sync';

const state: ZoomOAuthState = {
  nonce: 'n'.repeat(32), accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
  expiresAt: 1_900_000_000_000, verifier: 'v'.repeat(64),
};

describe('Zoom OAuth state cookie', () => {
  it('round-trips only with the same secret and an untouched value', () => {
    const cookie = signZoomState('secret', state);
    expect(readZoomState('secret', cookie)).toEqual(state);
    expect(readZoomState('other', cookie)).toBeNull();
    const [body, mac] = cookie.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), a: state.userId })).toString('base64url');
    expect(readZoomState('secret', `${forged}.${mac}`)).toBeNull();
    expect(readZoomState('secret', `${cookie}.x`)).toBeNull();
    expect(readZoomState('secret', null)).toBeNull();
    expect(readZoomState('secret', 'x'.repeat(2001))).toBeNull();
  });

  it('rejects malformed fields even when signed', () => {
    expect(readZoomState('secret', signZoomState('secret', { ...state, verifier: 'short' }))).toBeNull();
    expect(readZoomState('secret', signZoomState('secret', { ...state, accountId: 'not-a-uuid' }))).toBeNull();
  });

  it('derives the S256 challenge (RFC 7636 appendix B vector)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('Zoom scopes', () => {
  it('accepts granular or classic names and an unlisted grant', () => {
    expect(missingZoomScopes(['meeting:write:admin', 'meeting:read:admin', 'user:read:admin'])).toEqual([]);
    expect(missingZoomScopes(['meeting:write:meeting:admin', 'meeting:update:meeting:admin', 'meeting:delete:meeting:admin',
      'meeting:read:list_meetings:admin', 'user:read:user:admin'])).toEqual([]);
    expect(missingZoomScopes(null)).toEqual([]);
    expect(missingZoomScopes(['meeting:write:admin'])).toEqual(['meeting:read:list_meetings:admin', 'user:read:user:admin']);
  });
});

describe('meeting topic and reference', () => {
  it('holds the service name and the reference only', () => {
    expect(meetingTopic('  Ayurveda   consult ', 'abcdefghij')).toBe('Ayurveda consult · abcdefghij');
    expect(meetingTopic('', 'abcdefghij')).toBe('Appointment · abcdefghij');
    expect(meetingTopic('x'.repeat(300), 'abcdefghij')).toHaveLength(150 + ' · abcdefghij'.length);
  });

  it('makes 10-character references from [a-z0-9]', () => {
    const refs = new Set(Array.from({ length: 200 }, newMeetingRef));
    for (const ref of refs) expect(ref).toMatch(/^[a-z0-9]{10}$/);
    expect(refs.size).toBe(200);
  });
});
