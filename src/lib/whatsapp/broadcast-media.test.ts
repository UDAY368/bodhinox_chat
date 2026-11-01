import { expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';
import type { MessageTemplate } from '@/types';
const mocks = vi.hoisted(() => ({ send: vi.fn(async () => ({ messageId: 'accepted' })), sign: vi.fn(async () => 'https://signed.example/media') }));
vi.mock('./meta-api', () => ({ sendTemplateMessage: mocks.send, MetaApiError: class extends Error {} }));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: mocks.sign }));
vi.mock('@/lib/jobs/dispatch', () => ({ dispatchOnce: async (_account: string, _key: string, send: () => unknown) => send(), UncertainDispatchError: class extends Error {} }));
import { deliverBroadcast } from './broadcast-core';

it('signs stored private template header media at dispatch when no explicit override exists', async () => {
  const chain = { update: () => chain, select: () => chain, eq: () => chain, neq: () => chain, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null, count: 0 }).then(resolve) };
  const db = { from: () => chain } as unknown as DataClient;
  await deliverBroadcast(db, { broadcastId: 'b', templateName: 'welcome', templateLanguage: 'en', phoneNumberId: 'pn', accessToken: 'secret', templateRow: { header_media_url: '/api/media/object?bucket=media&key=private' } as MessageTemplate, planned: [{ recipientRowId: 'r', phone: '+12025550123', params: [] }], rejected: 0 }, { accountId: 'tenant', assertLease: () => {}, attemptId: 'attempt' });
  expect(mocks.sign).toHaveBeenCalledWith('tenant', '/api/media/object?bucket=media&key=private');
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ messageParams: { headerMediaUrl: 'https://signed.example/media' } }));
});
