import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ authFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() => new Promise<Response>(() => {})) }));
vi.mock('@/lib/auth/client', () => ({ authFetch: h.authFetch }));

import {
  ActivityDetailBody, ActivityResults, AiActivity, INITIAL_ACTIVITY_STATE, createActivityLoader,
  type ActivityDetail, type ActivityEvent, type ActivityState, type Filters,
} from './ai-activity';
import { visibleAgentTabs } from './agent-tabs';
import { ALL_REPLY_EVENT_REASONS, REPLY_EVENT_OUTCOMES } from '@/lib/ai/reply-event-codes';

type Catalogue = Record<string, Record<string, unknown>>;
const load = (locale: string) => JSON.parse(readFileSync(`${process.cwd()}/messages/${locale}.json`, 'utf8')) as Catalogue;
const activity = (locale: string) => (load(locale).Agents as Record<string, Record<string, Record<string, string>>>).activity;
const en = load('en');
const render = (node: React.ReactNode) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ Agents: en.Agents }} onError={() => {}}>{node}</NextIntlClientProvider>,
);
const noop = () => {};

const event = (id: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id, created_at: '2026-11-02T10:00:00Z', conversation_id: null, contact: { id: 'c1', name: 'Asha', phone: null },
  outcome: 'replied', reason: 'answered', preview: 'hi', has_reply: true, model: 'gpt', total_tokens: 5, latency_ms: 800, ...extra,
});
const results = (state: Partial<ActivityState>) => render(
  <ActivityResults state={{ ...INITIAL_ACTIVITY_STATE, loading: false, ...state }} onRetry={noop} onLoadMore={noop} onOpen={noop} />,
);

beforeEach(() => {
  h.authFetch.mockReset().mockImplementation(() => new Promise<Response>(() => {}));
});

describe('AI activity labels', () => {
  it.each(['en', 'es', 'pt', 'ko'])('labels every outcome and reason code in %s', (locale) => {
    const t = activity(locale);
    for (const outcome of REPLY_EVENT_OUTCOMES) expect(t.outcomes[outcome], outcome).toBeTruthy();
    for (const reason of ALL_REPLY_EVENT_REASONS) expect(t.reasons[reason], reason).toBeTruthy();
    expect((load(locale).Agents as Record<string, unknown>).tabActivity).toBeTruthy();
  });

  it('renders the filters and a loading state before the first page arrives', () => {
    const html = render(<AiActivity />);
    expect(html).toContain('AI activity');
    expect(html).toContain('Any outcome');
    expect(html).toContain('Any reason');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('animate-spin');
  });
});

describe('AI activity states', () => {
  it('shows an alert and a retry button when the page fails to load', () => {
    const html = results({ failed: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t load the activity log.");
    expect(html).toContain('Try again');
  });

  it('shows the empty state when a period has no entries', () => {
    const html = results({ events: [] });
    expect(html).toContain('No activity in this period.');
    expect(html).not.toContain('<ul');
  });

  it('lists entries, falls back for a reason this build does not know, and offers Load more', () => {
    const html = results({ events: [event('e1'), event('e2', { outcome: 'error', reason: 'brand_new_code', contact: null })], cursor: 'next' });
    expect(html).toContain('Asha');
    expect(html).toContain('Other (brand_new_code)');
    expect(html).toContain('Unknown contact');
    expect(html).toContain('Load more');
  });

  it('links the detail to the conversation with the param the inbox reads (?c=)', () => {
    const detail: ActivityDetail = {
      ...event('e1'), conversation_id: '44444444-4444-4444-8444-444444444444', customer_text: 'hi', reply_text: 'Hello!',
      sources: [], confidence: 0.9, guard_flags: [], provider: 'openai', prompt_tokens: 3, completion_tokens: 2,
    };
    const html = render(<ActivityDetailBody detail={detail} onClose={noop} />);
    expect(html).toContain('href="/inbox?c=44444444-4444-4444-8444-444444444444"');
    expect(html).toContain('Open conversation');
    expect(render(<ActivityDetailBody detail={{ ...detail, conversation_id: null }} onClose={noop} />)).not.toContain('/inbox');
  });
});

describe('AI activity loader', () => {
  const filters = (outcome: string): Filters => ({ outcome, reason: 'any', range: '7d' });
  const deferred = () => {
    let resolve!: (res: Response) => void;
    const promise = new Promise<Response>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const page = (ids: string[], next: string | null = null) => new Response(JSON.stringify({ events: ids.map((id) => event(id)), next_cursor: next }));
  const harness = () => {
    let state = INITIAL_ACTIVITY_STATE;
    const loader = createActivityLoader((next) => { state = next(state); });
    return { loader, state: () => state };
  };

  it('keeps only the newest filter when responses arrive out of order', async () => {
    const handedOff = deferred();
    const error = deferred();
    h.authFetch.mockReturnValueOnce(handedOff.promise).mockReturnValueOnce(error.promise);
    const { loader, state } = harness();
    const first = loader(filters('handed_off'), null);
    const second = loader(filters('error'), null);
    error.resolve(page(['error-row'], 'error-cursor'));
    await second;
    handedOff.resolve(page(['handed-off-row'], 'handed-off-cursor'));
    await first;
    expect(state().events.map((e) => e.id)).toEqual(['error-row']);
    expect(state().cursor).toBe('error-cursor');
    expect(state().loading).toBe(false);
    expect(String(h.authFetch.mock.calls[1][0])).toContain('outcome=error');
  });

  it('drops a Load more that returns after the filters changed', async () => {
    h.authFetch.mockResolvedValueOnce(page(['old-1'], 'old-cursor'));
    const { loader, state } = harness();
    await loader(filters('any'), null);
    const more = deferred();
    const reset = deferred();
    h.authFetch.mockReturnValueOnce(more.promise).mockReturnValueOnce(reset.promise);
    const loadMore = loader(filters('any'), 'old-cursor');
    const changed = loader(filters('error'), null);
    reset.resolve(page(['new-1']));
    await changed;
    more.resolve(page(['old-2'], 'old-cursor-2'));
    await loadMore;
    expect(state().events.map((e) => e.id)).toEqual(['new-1']);
    expect(state().cursor).toBeNull();
  });

  it('ignores a failure from a superseded request', async () => {
    const stale = deferred();
    h.authFetch.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(page(['fresh']));
    const { loader, state } = harness();
    const first = loader(filters('any'), null);
    await loader(filters('error'), null);
    stale.resolve(new Response('nope', { status: 500 }));
    await first;
    expect(state()).toMatchObject({ failed: false, loading: false });
    expect(state().events.map((e) => e.id)).toEqual(['fresh']);
  });
});

describe('AI Agents tabs', () => {
  it.each(['agent', 'viewer'] as const)('hides Activity and Usage from a %s', (role) => {
    expect(visibleAgentTabs(role)).not.toContain('activity');
    expect(visibleAgentTabs(role)).not.toContain('usage');
  });

  it.each(['owner', 'admin'] as const)('shows Activity to an %s', (role) => {
    expect(visibleAgentTabs(role)).toContain('activity');
  });

  it('shows no admin tab before the role is known', () => {
    expect(visibleAgentTabs(null)).not.toContain('activity');
  });
});
