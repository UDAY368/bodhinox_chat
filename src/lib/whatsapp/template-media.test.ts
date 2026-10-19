import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/storage/server', () => ({
  providerMediaUrl: vi.fn(async () => 'https://storage.test/signed.png'),
}));
import { resolveTemplateMediaParams } from './template-media';
import { providerMediaUrl } from '@/lib/storage/server';

describe('template send media', () => {
  it('signs an uploaded template header at send time and preserves body params', async () => {
    const template = { header_media_url: '/api/media/object?bucket=chat-media&key=sample.png' };
    const result = await resolveTemplateMediaParams('account-1', template, { body: ['Ada'] });
    expect(providerMediaUrl).toHaveBeenLastCalledWith('account-1', template.header_media_url);
    expect(result).toEqual({ body: ['Ada'], headerMediaUrl: 'https://storage.test/signed.png' });
    expect(template.header_media_url).toContain('/api/media/object?');
  });
  it('signs a per-message media override', async () => {
    await resolveTemplateMediaParams('account-1', { header_media_url: 'https://old.test/image.png' }, { headerMediaUrl: '/api/media/object?bucket=chat-media&key=override.png' });
    expect(providerMediaUrl).toHaveBeenLastCalledWith('account-1', '/api/media/object?bucket=chat-media&key=override.png');
  });
  it('preserves a Meta media ID without signing an unused link', async () => {
    vi.mocked(providerMediaUrl).mockClear();
    await expect(resolveTemplateMediaParams('account-1', { header_media_url: '/api/media/object?key=unused' }, { headerMediaId: 'meta-id' })).resolves.toEqual({ headerMediaId: 'meta-id' });
    expect(providerMediaUrl).not.toHaveBeenCalled();
  });
});
