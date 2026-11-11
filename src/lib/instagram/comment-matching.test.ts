// Stage 2C: which ig_comment flow a comment starts (pure matching). The
// first-comment-per-post rule and the database side are covered by
// comment-flow.integration.test.ts.
import { describe, expect, it } from 'vitest';
import type { IgCommentTriggerConfig } from '@/lib/flows/types';
import {
  commentMatchesTrigger, isNextPost, keywordListMatches, pickPublicReply, postScopeMatch, rankCommentFlows,
} from './comment-matching';

const IG = '11111111-1111-4111-8111-111111111111';
const comment = (text: string, mediaId: string | null = '1700') => ({ instagramAccountId: IG, mediaId, text });
const cfg = (over: Partial<IgCommentTriggerConfig> = {}): IgCommentTriggerConfig => ({ post_scope: 'any', ...over });

describe('keyword modes', () => {
  it('contains matches anywhere, case- and space-insensitively', () => {
    expect(keywordListMatches('Whats the PRICE?', ['price'], 'contains')).toBe(true);
    expect(keywordListMatches('  Link please ', ['LINK'], undefined)).toBe(true);
    expect(keywordListMatches('hello', ['price'], 'contains')).toBe(false);
  });
  it('exact matches the whole comment only', () => {
    expect(keywordListMatches(' Price ', ['price'], 'exact')).toBe(true);
    expect(keywordListMatches('price?', ['price'], 'exact')).toBe(false);
  });
  it('ignores blank keywords and non-lists', () => {
    expect(keywordListMatches('anything', ['', '  '], 'contains')).toBe(false);
    expect(keywordListMatches('anything', 'price', 'contains')).toBe(false);
  });
});

describe('commentMatchesTrigger', () => {
  it('an empty include list matches any comment; the exclude list wins', () => {
    expect(commentMatchesTrigger(cfg(), comment('love it'))).toBe('yes');
    expect(commentMatchesTrigger(cfg({ include_keywords: ['price'] }), comment('love it'))).toBe('no');
    expect(commentMatchesTrigger(cfg({ include_keywords: ['price'] }), comment('price pls'))).toBe('yes');
    expect(commentMatchesTrigger(cfg({ include_keywords: ['price'], exclude_keywords: ['scam'] }), comment('price? scam'))).toBe('no');
    expect(commentMatchesTrigger(cfg({ exclude_keywords: ['spam'], exclude_mode: 'exact' }), comment('not spam'))).toBe('yes');
  });
  it('listens only on its own account when one is chosen', () => {
    expect(commentMatchesTrigger(cfg({ instagram_account_id: '22222222-2222-4222-8222-222222222222' }), comment('hi'))).toBe('no');
    expect(commentMatchesTrigger(cfg({ instagram_account_id: IG }), comment('hi'))).toBe('yes');
  });
  it('specific posts match only the listed media', () => {
    const specific = cfg({ post_scope: 'specific', media_ids: ['1700', '1800'] });
    expect(commentMatchesTrigger(specific, comment('hi', '1800'))).toBe('yes');
    expect(commentMatchesTrigger(specific, comment('hi', '1900'))).toBe('no');
    expect(commentMatchesTrigger(specific, comment('hi', null))).toBe('no');
  });
  it('next post: resolved matches only that post; unresolved needs the publish-time check', () => {
    const next = cfg({ post_scope: 'next', next_after: '2026-11-10T10:00:00Z' });
    expect(postScopeMatch(next, '1700')).toBe('check');
    expect(postScopeMatch(next, '1700', '1700')).toBe('yes');
    expect(postScopeMatch(next, '1800', '1700')).toBe('no');
    expect(postScopeMatch({ ...next, resolved_media_id: '1700' }, '1700')).toBe('yes');
    expect(postScopeMatch({ post_scope: 'next' }, '1700')).toBe('no');
    // A keyword miss is a miss whatever the post.
    expect(commentMatchesTrigger({ ...next, include_keywords: ['price'] }, comment('hi'))).toBe('no');
  });
});

describe('next-post resolution', () => {
  const media = [
    { id: '30', timestamp: '2026-11-12T00:00:00Z' },
    { id: '20', timestamp: '2026-11-11T00:00:00Z' },
    { id: '10', timestamp: '2026-11-09T00:00:00Z' },
    { id: '40', timestamp: null },
  ];
  it('is the first post published after the choice was made', () => {
    expect(isNextPost('20', media, '2026-11-10T00:00:00Z')).toBe(true);
    expect(isNextPost('30', media, '2026-11-10T00:00:00Z')).toBe(false);
    expect(isNextPost('10', media, '2026-11-10T00:00:00Z')).toBe(false);
    expect(isNextPost('40', media, '2026-11-10T00:00:00Z')).toBe(false);
    expect(isNextPost('20', media, 'not a date')).toBe(false);
    expect(isNextPost(null, media, '2026-11-10T00:00:00Z')).toBe(false);
    expect(isNextPost('20', [], '2026-11-10T00:00:00Z')).toBe(false);
  });
});

describe('ranking and public replies', () => {
  it('ranks specific, then next, then any; oldest first within a scope', () => {
    const ranked = rankCommentFlows([
      { flowId: 'a', createdAt: '2026-01-01T00:00:00Z', config: cfg() },
      { flowId: 'b', createdAt: '2026-02-01T00:00:00Z', config: cfg({ post_scope: 'specific', media_ids: ['1'] }) },
      { flowId: 'c', createdAt: '2026-03-01T00:00:00Z', config: cfg({ post_scope: 'next' }) },
      { flowId: 'd', createdAt: '2026-01-15T00:00:00Z', config: cfg({ post_scope: 'specific', media_ids: ['1'] }) },
    ]);
    expect(ranked.map((f) => f.flowId)).toEqual(['d', 'b', 'c', 'a']);
  });
  it('picks one valid variant per comment, the same one on every retry', () => {
    const valid = (t: string) => t.trim().length > 0;
    const replies = ['One', 'Two', ' ', 'Three'];
    const first = pickPublicReply(replies, '18000000001', valid);
    expect(['One', 'Two', 'Three']).toContain(first);
    expect(pickPublicReply(replies, '18000000001', valid)).toBe(first);
    const picks = new Set(Array.from({ length: 30 }, (_, i) => pickPublicReply(replies, `1800000${i}`, valid)));
    expect(picks.size).toBeGreaterThan(1);
    expect(pickPublicReply([], '1', valid)).toBeNull();
    expect(pickPublicReply(undefined, '1', valid)).toBeNull();
  });
});
