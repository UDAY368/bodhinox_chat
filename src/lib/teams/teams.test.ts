import { describe, expect, it } from 'vitest';
import { MAX_TEAM_MEMBERS, MAX_TEAM_NAME, parseTeamInput, TeamError } from './teams';

const A = '11111111-1111-4111-8111-111111111111';
const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof TeamError ? error.code : 'other';
  }
};

describe('parseTeamInput', () => {
  it('requires a name on create and trims it', () => {
    expect(parseTeamInput({ name: '  Sales ', member_ids: [A, A.toUpperCase()] }, false)).toEqual({ name: 'Sales', member_ids: [A] });
    expect(code(() => parseTeamInput({ member_ids: [] }, false))).toBe('invalid_name');
    expect(code(() => parseTeamInput({ name: 'x'.repeat(MAX_TEAM_NAME + 1) }, false))).toBe('invalid_name');
  });

  it('accepts a partial update and refuses unknown keys or bad member lists', () => {
    expect(parseTeamInput({ member_ids: [] }, true)).toEqual({ member_ids: [] });
    expect(code(() => parseTeamInput({ name: 'x', account_id: A }, true))).toBe('invalid_name');
    expect(code(() => parseTeamInput({ member_ids: ['nope'] }, true))).toBe('invalid_members');
    expect(code(() => parseTeamInput({ member_ids: Array(MAX_TEAM_MEMBERS + 1).fill(A) }, true))).toBe('invalid_members');
    expect(code(() => parseTeamInput(null, true))).toBe('invalid_name');
  });
});
