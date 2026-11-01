import { describe, expect, it } from 'vitest';
import type { Tag } from '@/types';
import { groupTagsByCategory } from './tag-groups';

const tag = (name: string, category?: string | null): Tag => ({ id: name, user_id: 'u', name, color: '#000', category, created_at: '' });

describe('groupTagsByCategory', () => {
  it('sorts categories A–Z, puts uncategorised last and keeps tag order', () => {
    const groups = groupTagsByCategory([tag('vip', 'Status'), tag('misc'), tag('lead', 'Funnel'), tag('gold', 'Status'), tag('blank', '  ')]);
    expect(groups.map((g) => [g.category, g.tags.map((t) => t.name)])).toEqual([
      ['Funnel', ['lead']],
      ['Status', ['vip', 'gold']],
      [null, ['misc', 'blank']],
    ]);
  });

  it('returns one uncategorised group when no tag has a category', () => {
    expect(groupTagsByCategory([tag('a'), tag('b')])).toEqual([{ category: null, tags: [tag('a'), tag('b')] }]);
  });
});
