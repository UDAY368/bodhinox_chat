import { describe, expect, it } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { errorDetail } from './engine';

describe('errorDetail', () => {
  it("keeps Meta's details, which name the parameter it refused", () => {
    const err = new MetaApiError('(#131009) Parameter value is not valid', { code: 131009, httpStatus: 400, details: 'Flow is in draft state' });
    expect(errorDetail(err)).toBe('(#131009) Parameter value is not valid (Flow is in draft state)');
  });
  it('adds the Meta trace id so support can find the request, and ignores a malformed one', () => {
    const err = new MetaApiError('(#131009) bad', { code: 131009, httpStatus: 400, details: 'flow_id', fbtraceId: 'AbC-12_x' });
    expect(errorDetail(err)).toBe('(#131009) bad (flow_id) [fbtrace_id AbC-12_x]');
    expect(errorDetail(new MetaApiError('m', { httpStatus: 400, fbtraceId: 'a b<c>' }))).toBe('m');
  });
  it('falls back to the message, and caps long details', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail('plain')).toBe('plain');
    const long = new MetaApiError('x', { httpStatus: 400, details: 'd'.repeat(500) });
    expect(errorDetail(long)).toBe(`x (${'d'.repeat(300)})`);
  });
});
