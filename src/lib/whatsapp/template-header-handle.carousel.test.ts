import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'CARD_HANDLE' })),
}));
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));
vi.mock('@/lib/storage/server', () => ({
  providerMediaUrl: vi.fn(async (_account: string, url: string) => `https://storage.test/signed?u=${encodeURIComponent(url)}`),
}));

import { ensureCarouselCardHandles } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { TemplatePayload } from './template-validators';
import type { CarouselCard } from '@/types';
import { getT } from '@/lib/i18n/translate';

const t = getT('Validation.templates');

function response(type: string, size = 1024): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

const card = (over: Partial<CarouselCard> = {}): CarouselCard => ({
  header_type: 'image',
  header_media_url: 'https://x.test/card.jpg',
  body_text: 'Item',
  buttons: [{ type: 'QUICK_REPLY', text: 'More' }],
  ...over,
});

const carousel = (cards: CarouselCard[]): TemplatePayload => ({
  name: 'c',
  category: 'Marketing',
  language: 'en_US',
  template_kind: 'carousel',
  body_text: 'Picks',
  cards,
});

describe('ensureCarouselCardHandles', () => {
  beforeEach(() => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.mocked(uploadResumableMedia).mockClear();
    vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uploads each card sample that lacks a handle, through the account-signed URL', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(response('video/mp4'));
    vi.stubGlobal('fetch', network);
    const p = carousel([
      card({ header_type: 'video', header_media_url: 'https://x.test/a.mp4' }),
      card({ header_type: 'video', header_handle: 'kept' }),
      card({ header_type: 'video', header_media_url: 'https://x.test/c.mp4' }),
    ]);
    await ensureCarouselCardHandles(p, 'tok', 'account-1');
    expect(p.cards!.map((c) => c.header_handle)).toEqual(['CARD_HANDLE', 'kept', 'CARD_HANDLE']);
    expect(network).toHaveBeenCalledTimes(2);
    expect(String(network.mock.calls[0][0])).toContain('storage.test/signed');
    expect(vi.mocked(uploadResumableMedia).mock.calls[0][0]).toMatchObject({ mimeType: 'video/mp4', fileName: 'header.mp4' });
  });

  it('is a no-op for other kinds', async () => {
    const network = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', network);
    await ensureCarouselCardHandles({ ...carousel([card()]), template_kind: 'standard' }, 'tok');
    expect(network).not.toHaveBeenCalled();
  });

  it('names the card whose sample fails the SSRF guard', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response('image/jpeg')));
    vi.mocked(isDeliverableUrl).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const p = carousel([card(), card({ header_media_url: 'https://internal.test/x.jpg' })]);
    await expect(ensureCarouselCardHandles(p, 'tok')).rejects.toThrow(
      t('cardError', { n: 2, message: t('headerUrlUnreachable') }),
    );
    expect(p.cards![0].header_handle).toBe('CARD_HANDLE');
    expect(p.cards![1].header_handle).toBeUndefined();
  });

  it('rejects a card sample of the wrong media type', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response('application/pdf')));
    await expect(ensureCarouselCardHandles(carousel([card()]), 'tok')).rejects.toThrow(
      t('cardError', {
        n: 1,
        message: t('headerWrongType', { kind: 'image', formats: 'JPEG or PNG', contentType: 'application/pdf' }),
      }),
    );
  });
});
