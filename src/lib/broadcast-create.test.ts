import { expect, it, vi } from 'vitest';
import { requestBroadcastCreation } from './broadcast-create';

it('submits campaign intent once to the server without client counters or recipient writes', async () => {
  const send = vi.fn(async () => Response.json({ id: 'campaign' }, { status: 202 }));
  expect(await requestBroadcastCreation({ name: 'Welcome', templateId: 'template', audience: { type: 'all' }, variables: {} }, send)).toBe('campaign');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toEqual(['/api/broadcasts/create', expect.objectContaining({ method: 'POST' })]);
  expect(JSON.parse((send.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ name: 'Welcome', templateId: 'template', audience: { type: 'all' }, variables: {} });
});

it('surfaces rejected campaign creation without reporting it queued', async () => {
  await expect(requestBroadcastCreation({ name: 'Welcome', templateId: 'template', audience: { type: 'all' }, variables: {} }, async () => Response.json({ error: 'Template is not approved' }, { status: 400 }))).rejects.toThrow('Template is not approved');
});

it('omits an empty optional media value from the wizard', async () => {
  const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => { void _url; void _init; return Response.json({ id: 'campaign' }); });
  await requestBroadcastCreation({ name: 'Welcome', templateId: 'template', audience: { type: 'all' }, variables: {}, headerMediaUrl: '' }, send);
  expect(JSON.parse(send.mock.calls[0][1]!.body as string)).not.toHaveProperty('headerMediaUrl');
});
