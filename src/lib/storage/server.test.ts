import { expect, it } from 'vitest';
import { createServerStorageFacade } from './server';
const accountId = '11111111-1111-4111-8111-111111111111';
it('server storage rejects foreign paths and viewer writes before touching object storage', async () => {
  const storage = createServerStorageFacade({ accountId, role: 'viewer' });
  expect(
    (
      await storage
        .from('chat-media')
        .upload(`account-${accountId}/a.png`, new Uint8Array([1]), {
          contentType: 'image/png',
        })
    ).error
  ).not.toBeNull();
  expect(
    (
      await storage
        .from('chat-media')
        .remove(['account-22222222-2222-4222-8222-222222222222/a.png'])
    ).error
  ).not.toBeNull();
  expect(() =>
    storage
      .from('chat-media')
      .getPublicUrl('account-22222222-2222-4222-8222-222222222222/a.png')
  ).toThrow();
});
it('server URL compatibility returns an authenticated proxy reference', () => {
  const storage = createServerStorageFacade({ accountId, role: 'owner' });
  expect(
    storage.from('chat-media').getPublicUrl(`account-${accountId}/a.png`).data
      .publicUrl
  ).toContain('/api/media/object?bucket=chat-media&key=');
});
