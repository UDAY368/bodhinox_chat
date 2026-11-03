import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversionEventDto } from '@/lib/meta-ads/capi';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/auth/client', () => ({ authFetch: h.fetch }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountRole: 'admin' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ConversionsPanel, appendPage, conversionsUrl, fetchConversionsPage } from './conversions-panel';

const event = (id: string) => ({ id }) as ConversionEventDto;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('ConversionsPanel paging', () => {
  beforeEach(() => h.fetch.mockReset());

  it('builds the list URL with the status filter and the keyset cursor', () => {
    expect(conversionsUrl('')).toBe('/api/meta-ads/conversions');
    expect(conversionsUrl('review')).toBe('/api/meta-ads/conversions?status=review');
    expect(conversionsUrl('sent', 'abc-_1')).toBe('/api/meta-ads/conversions?status=sent&cursor=abc-_1');
    expect(conversionsUrl('', 'a+b/c')).toBe('/api/meta-ads/conversions?cursor=a%2Bb%2Fc');
  });

  it('fetches a page and its next cursor, then the following page by that cursor', async () => {
    h.fetch.mockResolvedValueOnce(json({ events: [event('1'), event('2')], nextCursor: 'c1' }));
    h.fetch.mockResolvedValueOnce(json({ events: [event('3')], nextCursor: null }));
    const first = await fetchConversionsPage('failed');
    expect(first).toEqual({ events: [event('1'), event('2')], nextCursor: 'c1' });
    const second = await fetchConversionsPage('failed', first.nextCursor);
    expect(h.fetch).toHaveBeenLastCalledWith('/api/meta-ads/conversions?status=failed&cursor=c1');
    expect(appendPage(first.events, second.events).map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(second.nextCursor).toBeNull();
  });

  it('treats a missing or non-string nextCursor as the last page', async () => {
    h.fetch.mockResolvedValueOnce(json({ events: [] }));
    expect((await fetchConversionsPage('')).nextCursor).toBeNull();
    h.fetch.mockResolvedValueOnce(json({ events: [], nextCursor: 5 }));
    expect((await fetchConversionsPage('')).nextCursor).toBeNull();
  });

  it('fails on an error response or a malformed body', async () => {
    h.fetch.mockResolvedValueOnce(json({ code: 'invalid' }, 400));
    await expect(fetchConversionsPage('', 'bad')).rejects.toThrow();
    h.fetch.mockResolvedValueOnce(json({ events: 'nope' }));
    await expect(fetchConversionsPage('')).rejects.toThrow();
  });

  it('never shows a row twice when pages overlap', () => {
    expect(appendPage([event('1'), event('2')], [event('2'), event('3')]).map((e) => e.id)).toEqual(['1', '2', '3']);
  });

  it('shows the admin-only note, and no list or Load more, to non-admins', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
        <ConversionsPanel canResolve={false} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('Ads.conversions.adminOnly');
    expect(html).not.toContain('Ads.conversions.loadMore');
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
