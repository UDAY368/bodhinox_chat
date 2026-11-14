import { describe, expect, it } from 'vitest';
import { previewSrcOf } from './graph';
import { changeOf } from '@/components/ads/ads-overview';

describe('previewSrcOf', () => {
  it("keeps only Meta's own preview page address", () => {
    const src = 'https://www.facebook.com/ads/api/preview_iframe.php?d=AQ&amp;t=AQ';
    expect(previewSrcOf(`<iframe src="${src}" width="335"></iframe>`)).toBe('https://www.facebook.com/ads/api/preview_iframe.php?d=AQ&t=AQ');
    expect(previewSrcOf('<iframe src="https://evil.example/ads/api/preview_iframe.php"></iframe>')).toBeNull();
    expect(previewSrcOf('<iframe src="http://www.facebook.com/ads/api/preview_iframe.php"></iframe>')).toBeNull();
    expect(previewSrcOf('<iframe src="https://www.facebook.com/login"></iframe>')).toBeNull();
    expect(previewSrcOf(null)).toBeNull();
  });
});

describe('changeOf', () => {
  it('compares with the previous period, and says when lower is better', () => {
    expect(changeOf(120, 100)).toEqual({ pct: 20, good: true });
    expect(changeOf(80, 100, false)).toEqual({ pct: -20, good: true });
    expect(changeOf(5, 0)).toBeNull();
    expect(changeOf(null, 10)).toBeNull();
    expect(changeOf(100.2, 100)).toBeNull();
  });
});
