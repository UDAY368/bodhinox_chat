import { beforeEach, expect, it, vi } from 'vitest';
import { addContactTag, deleteContactTag } from './tag-api';
import { authFetch } from '@/lib/auth/client';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it('uses authenticated requests for adding and removing a contact tag', async () => {
  vi.mocked(authFetch).mockResolvedValue(
    new Response(JSON.stringify({ added: true }), { status: 200 })
  );
  await addContactTag('c1', 't1');
  await deleteContactTag('c1', 't1');
  expect(authFetch).toHaveBeenNthCalledWith(1, '/api/contacts/c1/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_id: 't1' }),
  });
  expect(authFetch).toHaveBeenNthCalledWith(2, '/api/contacts/c1/tags', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_id: 't1' }),
  });
});

it('surfaces tag permission errors', async () => {
  vi.mocked(authFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  );
  await expect(addContactTag('c1', 't1')).rejects.toThrow('Forbidden');
});
