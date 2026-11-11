// Stage 5 (5F) gallery filters: by goal, by trigger (a template without a
// trigger is in neither trigger filter), and the search text.
import { describe, expect, it } from 'vitest';
import { matchesGalleryFilter, type TemplateSummary } from './template-gallery';

const template = (over: Partial<TemplateSummary>): TemplateSummary => ({
  slug: 's', name: 'Giveaway draw', description: 'Comment to enter', icon: 'Gift', category: 'instagram_growth',
  trigger_type: 'ig_comment', node_count: 5,
  meta: { goals: ['grow_followers'], trigger: 'post_comment', kind: 'flow', level: 'beginner', uses_ai: false, needs_payments: false },
  ...over,
});

describe('matchesGalleryFilter', () => {
  it('shows everything under All templates', () => {
    expect(matchesGalleryFilter(template({ meta: undefined }), { kind: 'all' }, '')).toBe(true);
  });

  it('filters by goal and by trigger', () => {
    const t = template({});
    expect(matchesGalleryFilter(t, { kind: 'goal', value: 'grow_followers' }, '')).toBe(true);
    expect(matchesGalleryFilter(t, { kind: 'goal', value: 'drive_traffic' }, '')).toBe(false);
    expect(matchesGalleryFilter(t, { kind: 'trigger', value: 'post_comment' }, '')).toBe(true);
    expect(matchesGalleryFilter(t, { kind: 'trigger', value: 'dm' }, '')).toBe(false);
  });

  it('keeps a template without a trigger, or without metadata, out of the trigger and goal filters', () => {
    const triggerless = template({ meta: { ...template({}).meta!, trigger: null } });
    for (const value of ['post_comment', 'dm', 'story_reply', 'live_comment'] as const)
      expect(matchesGalleryFilter(triggerless, { kind: 'trigger', value }, '')).toBe(false);
    expect(matchesGalleryFilter(template({ meta: undefined }), { kind: 'goal', value: 'grow_followers' }, '')).toBe(false);
  });

  it('searches the name and description, ignoring case and spaces around the query', () => {
    expect(matchesGalleryFilter(template({}), { kind: 'all' }, '  GIVEAWAY ')).toBe(true);
    expect(matchesGalleryFilter(template({}), { kind: 'all' }, 'to enter')).toBe(true);
    expect(matchesGalleryFilter(template({}), { kind: 'all' }, 'quiz')).toBe(false);
  });
});
