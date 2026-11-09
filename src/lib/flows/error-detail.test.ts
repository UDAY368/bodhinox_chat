import { describe, expect, it } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { errorDetail } from './engine';

describe('errorDetail', () => {
  it("keeps Meta's details, which name the parameter it refused", () => {
    const err = new MetaApiError('(#131009) Parameter value is not valid', { code: 131009, httpStatus: 400, details: 'Flow is in draft state' });
    expect(errorDetail(err)).toBe('(#131009) Parameter value is not valid (Flow is in draft state)');
  });
  it('falls back to the message, and caps long details', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail('plain')).toBe('plain');
    const long = new MetaApiError('x', { httpStatus: 400, details: 'd'.repeat(500) });
    expect(errorDetail(long)).toBe(`x (${'d'.repeat(300)})`);
  });
});
