// The post/reel picker's paging: one page per request, the cursor passed back
// as ?after=, and a post that shows up on two pages kept once.
import { describe, expect, it, vi } from 'vitest';

import type { InstagramMedia } from '@/lib/instagram/graph';
import { loadPosts, mergePostPages } from './ig-post-picker';

const post = (id: string, isReel = false): InstagramMedia =>
  ({ id, caption: null, mediaType: isReel ? 'VIDEO' : 'IMAGE', previewUrl: null, permalink: null, timestamp: null, isReel });

describe('loadPosts', () => {
  it('reads one page and passes the cursor of the next one back as ?after=', async () => {
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('after=') ? { posts: [post('3')], next: null } : { posts: [post('1'), post('2', true)], next: 'QVF+next' })));
    const first = await loadPosts('acc', undefined, fetcher as never);
    expect(first).toEqual({ posts: [post('1'), post('2', true)], next: 'QVF+next' });
    const second = await loadPosts('acc', first!.next, fetcher as never);
    expect(second).toEqual({ posts: [post('3')], next: null });
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['/api/instagram/accounts/acc/media', '/api/instagram/accounts/acc/media?after=QVF%2Bnext']);
  });

  it('answers null on a failed or malformed response, so the picker offers a retry', async () => {
    expect(await loadPosts('acc', undefined, (async () => new Response('{}', { status: 502 })) as never)).toBeNull();
    expect(await loadPosts('acc', undefined, (async () => new Response('{"posts":"x"}')) as never)).toBeNull();
    expect(await loadPosts('acc', undefined, (async () => { throw new Error('offline'); }) as never)).toBeNull();
  });
});

describe('mergePostPages', () => {
  it('appends the next page and keeps a post published in between only once', () => {
    expect(mergePostPages([post('1'), post('2')], [post('2'), post('3', true)]).map((p) => p.id)).toEqual(['1', '2', '3']);
  });
});
