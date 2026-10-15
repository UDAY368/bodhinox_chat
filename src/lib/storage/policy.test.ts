import { describe, expect, it } from 'vitest';
import { authorizeObject, storageKey, validateUpload } from './policy';

const accountId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
describe('private tenant media', () => {
  it('rejects another account path and path traversal', () => {
    for (const path of ['account-00000000-0000-4000-8000-000000000003/a.png', `account-${accountId}/../a.png`, `account-${accountId}/%2e%2e/a.png`]) {
      expect(() => authorizeObject('chat-media', path, { accountId, userId }, 'read')).toThrow();
    }
    expect(storageKey('chat-media', `account-${accountId}/a.png`, { accountId, userId })).toBe(`${accountId}/chat-media/account-${accountId}/a.png`);
  });
  it('limits uploads by type and size rather than accepting arbitrary files', () => {
    expect(() => validateUpload('chat-media', 'image/png', 1024)).not.toThrow();
    expect(() => validateUpload('chat-media', 'application/x-msdownload', 1024)).toThrow();
    expect(() => validateUpload('avatars', 'image/png', 6 * 1024 * 1024)).toThrow();
    expect(() => validateUpload('chat-media', 'image/png', 17 * 1024 * 1024)).toThrow();
  });
  it('allows only own avatar writes and refuses unrecognized buckets', () => {
    expect(() => authorizeObject('avatars', `${userId}/avatar.png`, { accountId, userId }, 'write')).not.toThrow();
    expect(() => authorizeObject('avatars', '00000000-0000-4000-8000-000000000003/avatar.png', { accountId, userId }, 'write')).toThrow();
    expect(() => authorizeObject('private-secrets', `${userId}/a`, { accountId, userId }, 'read')).toThrow();
  });
});
