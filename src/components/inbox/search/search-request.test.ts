import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('@/lib/auth/client', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

import { fetchSearchPage, jumpRequestFor } from './search-request';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchSearchPage', () => {
  beforeEach(() => authFetch.mockReset());

  it('goes through authFetch (token refresh on 401) with the abort signal and no-store', async () => {
    authFetch.mockResolvedValue(json(200, { results: [{ message_id: 'm1' }], next_cursor: 'C2' }));
    const controller = new AbortController();
    const page = await fetchSearchPage('/api/inbox/search?q=x', controller.signal);
    expect(authFetch).toHaveBeenCalledWith('/api/inbox/search?q=x', { signal: controller.signal, cache: 'no-store' });
    expect(page).toEqual({ ok: true, results: [{ message_id: 'm1' }], nextCursor: 'C2' });
  });

  it('maps 429 to rate_limited and other failures to error', async () => {
    const signal = new AbortController().signal;
    authFetch.mockResolvedValueOnce(json(429, {}));
    expect(await fetchSearchPage('/api/inbox/search?q=x', signal)).toEqual({ ok: false, failure: 'rate_limited' });
    authFetch.mockResolvedValueOnce(json(503, {}));
    expect(await fetchSearchPage('/api/inbox/search?q=x', signal)).toEqual({ ok: false, failure: 'error' });
    authFetch.mockRejectedValueOnce(new TypeError('network'));
    expect(await fetchSearchPage('/api/inbox/search?q=x', signal)).toEqual({ ok: false, failure: 'error' });
  });

  it('rethrows when the request was aborted so superseded searches are dropped', async () => {
    const controller = new AbortController();
    authFetch.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(fetchSearchPage('/api/inbox/search?q=x', controller.signal)).rejects.toThrow('aborted');
  });
});

describe('jumpRequestFor', () => {
  const request = { conversationId: 'A', messageId: 'M', nonce: 1 };

  it('passes the jump only to the conversation it was made for', () => {
    expect(jumpRequestFor(request, 'A')).toEqual({ messageId: 'M', nonce: 1 });
    // Back, then opening conversation B: the old jump must not replay there.
    expect(jumpRequestFor(request, 'B')).toBeNull();
    expect(jumpRequestFor(request, null)).toBeNull();
    expect(jumpRequestFor(null, 'A')).toBeNull();
  });
});
