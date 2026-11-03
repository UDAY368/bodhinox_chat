import { describe, expect, it } from 'vitest';

import { presetSegmentAudience } from './preset-segment';

const segments = [{ id: 'seg-1' }, { id: 'seg-2' }];

describe('presetSegmentAudience', () => {
  it('preselects a segment that belongs to the workspace', () => {
    expect(presetSegmentAudience({ type: 'all' }, 'seg-2', segments)).toEqual({ type: 'segment', segmentId: 'seg-2' });
  });

  it('ignores an id that is not one of the workspace segments', () => {
    const all = { type: 'all' } as const;
    expect(presetSegmentAudience(all, 'other-account-seg', segments)).toBe(all);
    expect(presetSegmentAudience(all, 'seg-1', [])).toBe(all);
  });

  it('keeps an audience the user already chose', () => {
    const tags = { type: 'tags' as const, tagIds: ['t1'] };
    expect(presetSegmentAudience(tags, 'seg-1', segments)).toBe(tags);
  });
});
