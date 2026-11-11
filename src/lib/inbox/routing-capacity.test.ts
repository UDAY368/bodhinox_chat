// Stage 5 (5E): assignment capacity and the 'basic' even spread (pure parts).
import { describe, expect, it } from 'vitest';

import { hasCapacity, MAX_OPEN_CONVERSATIONS_LIMIT, nextInRotation, parseCapacityInput, RoutingRuleError } from './routing';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof RoutingRuleError ? error.code : 'other';
  }
};

describe('agent capacity', () => {
  it('a member with no limit always has room; a member at the limit has none', () => {
    expect(hasCapacity(500, null)).toBe(true);
    expect(hasCapacity(2, 3)).toBe(true);
    expect(hasCapacity(3, 3)).toBe(false);
    expect(hasCapacity(4, 3)).toBe(false);
  });

  it('accepts 1 to 1000 or null, and nothing else', () => {
    expect(parseCapacityInput({ max_open_conversations: null })).toBeNull();
    expect(parseCapacityInput({ max_open_conversations: 1 })).toBe(1);
    expect(parseCapacityInput({ max_open_conversations: MAX_OPEN_CONVERSATIONS_LIMIT })).toBe(1000);
    for (const bad of [0, -1, 1001, 2.5, '5', undefined])
      expect(codeOf(() => parseCapacityInput({ max_open_conversations: bad }))).toBe('invalid_capacity');
    expect(codeOf(() => parseCapacityInput({}))).toBe('invalid_capacity');
    expect(codeOf(() => parseCapacityInput(null))).toBe('invalid_capacity');
  });
});

describe('basic assignment rotation', () => {
  const ordered = [a, b, c];

  it('takes the next eligible member after the last one, wrapping round', () => {
    const all = new Set(ordered);
    expect(nextInRotation(ordered, all, null)).toBe(a);
    expect(nextInRotation(ordered, all, a)).toBe(b);
    expect(nextInRotation(ordered, all, b)).toBe(c);
    expect(nextInRotation(ordered, all, c)).toBe(a);
  });

  it('skips members who are full or offline, and gives nobody when everyone is', () => {
    expect(nextInRotation(ordered, new Set([a, c]), a)).toBe(c);
    expect(nextInRotation(ordered, new Set([b]), b)).toBe(b);
    expect(nextInRotation(ordered, new Set(), a)).toBeNull();
  });

  it('spreads a run of new conversations evenly', () => {
    const counts = new Map<string, number>();
    let last: string | null = null;
    for (let i = 0; i < 9; i++) {
      last = nextInRotation(ordered, new Set(ordered), last);
      counts.set(last!, (counts.get(last!) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([3, 3, 3]);
  });
});
