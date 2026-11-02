import { describe, expect, it } from 'vitest';
import { initialKeep, type DowngradeOverviewView } from './downgrade-dialog';
import { splitBytes, usedPercent } from './usage-meters';

describe('usage meter helpers', () => {
  it('formats bytes in binary units', () => {
    expect(splitBytes(512)).toEqual({ value: 512, unit: 'B' });
    expect(splitBytes(1536)).toEqual({ value: 1.5, unit: 'KB' });
    expect(splitBytes(10 * 1024 ** 3)).toEqual({ value: 10, unit: 'GB' });
    expect(splitBytes(-1)).toEqual({ value: 0, unit: 'B' });
  });

  it('caps the used percentage and treats unlimited as empty', () => {
    expect(usedPercent(50, 200)).toBe(25);
    expect(usedPercent(300, 200)).toBe(100);
    expect(usedPercent(5, null)).toBe(0);
    expect(usedPercent(undefined, 10)).toBe(0);
    expect(usedPercent(1, 0)).toBe(100);
  });
});

describe('initialKeep', () => {
  const view = (selection: DowngradeOverviewView['selection']): DowngradeOverviewView => ({
    plan: { id: 'basic', name: 'Basic' }, effectiveAt: null, pending: true, archived: [], selection,
    kinds: [
      { kind: 'segments', limit: 2, excess: 1, items: [{ id: 'a', name: 'A', lastUsedAt: null }, { id: 'b', name: 'B', lastUsedAt: null }, { id: 'c', name: 'C', lastUsedAt: null }] },
      { kind: 'lists', limit: 5, excess: 0, items: [{ id: 'l', name: 'L', lastUsedAt: null }] },
    ],
  });

  it('defaults to the most recently used up to the limit, only where over', () => {
    expect(initialKeep(view(null))).toEqual({ segments: ['a', 'b'] });
  });

  it('starts from the stored choice, dropping items no longer in use', () => {
    expect(initialKeep(view({ segments: ['gone', 'c'] }))).toEqual({ segments: ['c'] });
  });
});
