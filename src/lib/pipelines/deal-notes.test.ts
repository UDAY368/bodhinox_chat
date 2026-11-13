import { describe, expect, it } from 'vitest';
import { DEAL_NOTE_MAX, DealNoteError, dealNoteErrorResponse, parseDealNoteBody } from './deal-notes';

describe('parseDealNoteBody', () => {
  it('trims the note', () => {
    expect(parseDealNoteBody('  Asked for a demo \n')).toBe('Asked for a demo');
    expect(parseDealNoteBody('x'.repeat(DEAL_NOTE_MAX))).toHaveLength(DEAL_NOTE_MAX);
  });
  it.each([[''], ['   '], [null], [42], [{}], ['x'.repeat(DEAL_NOTE_MAX + 1)]])('refuses %j', (value) => {
    expect(() => parseDealNoteBody(value)).toThrow(DealNoteError);
  });
});

describe('dealNoteErrorResponse', () => {
  it('answers the code and status, never the input', async () => {
    const res = dealNoteErrorResponse(new DealNoteError('forbidden', 403));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', code: 'forbidden' });
  });
});
