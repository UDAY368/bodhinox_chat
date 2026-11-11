import { describe, expect, it } from 'vitest';
import { INSTAGRAM_LIMITS } from './graph-limits';
import { PostbackPayloadError, decodePostback, encodePostback, type InstagramPostback } from './postback-payloads';

const FLOW = '3f1c2a4e-9b7d-4c1a-8e2f-0a1b2c3d4e5f';
const RUN = 'a0b1c2d3-e4f5-4a6b-9c7d-8e9f0a1b2c3d';

describe('Instagram postback payloads', () => {
  it('round-trips each kind', () => {
    const cases: InstagramPostback[] = [
      { kind: 'ice_breaker', flowId: FLOW },
      { kind: 'menu', flowId: FLOW },
      { kind: 'opt_in', runId: RUN, nodeKey: 'private_reply' },
      { kind: 'follow_check', runId: RUN, nodeKey: 'Follow-gate_2' },
    ];
    for (const postback of cases) {
      const payload = encodePostback(postback);
      expect(payload.length).toBeLessThanOrEqual(INSTAGRAM_LIMITS.postbackPayloadChars);
      expect(decodePostback(payload)).toEqual(postback);
    }
    expect(encodePostback({ kind: 'ice_breaker', flowId: FLOW })).toBe(`ib:${FLOW}`);
    expect(encodePostback({ kind: 'menu', flowId: FLOW })).toBe(`menu:${FLOW}`);
    expect(encodePostback({ kind: 'opt_in', runId: RUN, nodeKey: 'n1' })).toBe(`optin:${RUN}:n1`);
    expect(encodePostback({ kind: 'follow_check', runId: RUN, nodeKey: 'n1' })).toBe(`follow-check:${RUN}:n1`);
  });

  it('normalises an upper-case id when encoding', () => {
    expect(encodePostback({ kind: 'ice_breaker', flowId: FLOW.toUpperCase() })).toBe(`ib:${FLOW}`);
  });

  it('refuses to encode an id or node key that would not decode', () => {
    expect(() => encodePostback({ kind: 'ice_breaker', flowId: 'not-a-uuid' })).toThrow(PostbackPayloadError);
    expect(() => encodePostback({ kind: 'menu', flowId: 'not-a-uuid' })).toThrow(PostbackPayloadError);
    expect(() => encodePostback({ kind: 'opt_in', runId: RUN, nodeKey: 'has:colon' })).toThrow(PostbackPayloadError);
    expect(() => encodePostback({ kind: 'follow_check', runId: RUN, nodeKey: '' })).toThrow(PostbackPayloadError);
    expect(() => encodePostback({ kind: 'opt_in', runId: RUN, nodeKey: 'x'.repeat(101) })).toThrow(PostbackPayloadError);
  });

  it('treats anything else as an ordinary reply id', () => {
    for (const payload of [
      'yes', '', 'ib:', `ib:${FLOW}:extra`, 'ib:not-a-uuid', `optin:${RUN}`, `optin:${RUN}:`, `optin:${RUN}:a:b`,
      `optin:${FLOW.toUpperCase()}:node`, `follow-check:x:node`, `unknown:${RUN}:node`, `IB:${FLOW}`, `ib:${FLOW} `,
      `optin:${RUN}:${'x'.repeat(200)}`, 42, null, undefined, { kind: 'ice_breaker' },
      'menu:', `menu:${FLOW}:extra`, 'menu:not-a-uuid', `MENU:${FLOW}`, `menu:${RUN}:node`,
    ]) expect(decodePostback(payload), String(payload)).toBeNull();
  });
});
