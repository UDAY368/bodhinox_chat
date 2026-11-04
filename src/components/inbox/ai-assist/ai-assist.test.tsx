import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import { afterDismiss, AiReplySuggestionsView, parseReplies } from './ai-reply-suggestions';
import { AiSummaryPanelView, parseSummary } from './ai-summary-panel';
import { parseAvailability, reasonKey } from './use-ai-assist';

const messages = {
  AiAssist: {
    summarize: 'Summarize with AI', summarizing: 'Summarizing…', summaryTitle: 'AI summary', openQuestions: 'Open questions',
    nextSteps: 'Next steps', reviewNote: 'AI-generated for staff.', dataAsOf: 'Records as of {time}.', close: 'Close',
    sensitiveBanner: 'Sensitive topic: route to qualified staff.', suggestReplies: 'Suggest replies', suggestionsTitle: 'Suggested replies',
    loadingSuggestions: 'Finding replies…', use: 'Use', dismiss: 'Dismiss', sources: 'Sources:',
    reviewBeforeSending: 'Review and edit before you send.', routeToStaffTitle: 'Route to qualified staff',
    routeToStaffBody: 'No reply was suggested.', errors: { notFound: 'Not available.', noMessages: 'No customer message.', failed: 'Could not reach AI.' },
  },
  AiFallback: { feature_off: 'This AI feature is turned off.', guard_blocked: 'Withheld for safety.' },
};
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{node}</NextIntlClientProvider>);
const noop = () => {};

describe('AiReplySuggestionsView', () => {
  it('shows options as plain text with review guidance, never as HTML', () => {
    const html = render(<AiReplySuggestionsView
      state={{ kind: 'options', options: [{ suggestionId: 's1', text: '<b>We deliver</b> to Pune' }], citations: [{ title: 'Shipping', source_url: 'https://beans.example/s' }] }}
      onUse={noop} onDismiss={noop} onClose={noop} />);
    expect(html).toContain('&lt;b&gt;We deliver&lt;/b&gt; to Pune');
    expect(html).toContain('Review and edit before you send.');
    expect(html).toContain('href="https://beans.example/s"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('shows route to staff instead of any text for a sensitive question', () => {
    const html = render(<AiReplySuggestionsView state={{ kind: 'route_to_staff', categories: ['treatment_or_dosage'] }} onUse={noop} onDismiss={noop} onClose={noop} />);
    expect(html).toContain('Route to qualified staff');
    expect(html).not.toContain('>Use<');
  });

  it('explains a fallback reason', () => {
    expect(render(<AiReplySuggestionsView state={{ kind: 'error', reason: 'guard_blocked' }} onUse={noop} onDismiss={noop} onClose={noop} />))
      .toContain('Withheld for safety.');
    expect(render(<AiReplySuggestionsView state={{ kind: 'error', reason: 'no_messages' }} onUse={noop} onDismiss={noop} onClose={noop} />))
      .toContain('No customer message.');
  });
});

describe('afterDismiss', () => {
  it('removes the dismissed option, and closes the panel when the last one is dismissed', () => {
    const state = { kind: 'options' as const, options: [{ suggestionId: 's1', text: 'A' }, { suggestionId: 's2', text: 'B' }], citations: [] };
    const one = afterDismiss(state, 's1');
    expect(one).toEqual({ ...state, options: [{ suggestionId: 's2', text: 'B' }] });
    // The server marked it rejected: it must not stay on screen with a Use button.
    expect(afterDismiss(one!, 's2')).toBeNull();
    expect(afterDismiss({ kind: 'loading' }, 's1')).toEqual({ kind: 'loading' });
  });
});

describe('parseReplies', () => {
  it('reads options, route to staff and fallbacks; drops unsafe link schemes', () => {
    expect(parseReplies({ ok: true, options: [{ suggestionId: 's1', text: 'Hi' }], citations: [{ title: 'T', source_url: 'javascript:alert(1)' }], routeToStaff: null }))
      .toEqual({ kind: 'options', options: [{ suggestionId: 's1', text: 'Hi' }], citations: [{ title: 'T', source_url: null }] });
    expect(parseReplies({ ok: true, options: [], routeToStaff: { suggestionId: 's2', categories: ['emergency_self_harm'] } }))
      .toEqual({ kind: 'route_to_staff', categories: ['emergency_self_harm'] });
    expect(parseReplies({ ok: false, reason: 'feature_off' })).toEqual({ kind: 'error', reason: 'feature_off' });
    expect(parseReplies(null)).toEqual({ kind: 'error', reason: null });
  });
});

describe('AiSummaryPanelView', () => {
  it('offers a summary button, then shows the summary with the sensitive banner', () => {
    expect(render(<AiSummaryPanelView state={{ kind: 'idle' }} onRun={noop} onClose={noop} />)).toContain('Summarize with AI');
    const html = render(<AiSummaryPanelView state={{ kind: 'done', view: {
      summary: 'Asks about price.', openQuestions: ['Price?'], nextSteps: ['Quote'], dataAsOf: '2026-11-04T10:00:00Z', sensitive: ['pregnancy_child_health'],
    } }} onRun={noop} onClose={noop} />);
    expect(html).toContain('Asks about price.');
    expect(html).toContain('Open questions');
    expect(html).toContain('Sensitive topic: route to qualified staff.');
    expect(html).toContain('AI-generated for staff.');
  });

  it('explains a fallback', () => {
    expect(render(<AiSummaryPanelView state={{ kind: 'error', reason: 'feature_off' }} onRun={noop} onClose={noop} />)).toContain('This AI feature is turned off.');
  });
});

describe('parsers', () => {
  it('parseSummary accepts only an ok summary', () => {
    expect(parseSummary({ ok: true, summary: 's', openQuestions: ['a', 1], nextSteps: null, dataAsOf: 'x', sensitive: [] }))
      .toEqual({ summary: 's', openQuestions: ['a'], nextSteps: [], dataAsOf: 'x', sensitive: [] });
    expect(parseSummary({ ok: false, reason: 'quota' })).toBeNull();
  });

  it('parseAvailability defaults to off', () => {
    expect(parseAvailability({ summary: { ok: true, reason: null } })).toEqual({ summary: { ok: true, reason: null }, suggest: { ok: false, reason: null } });
    expect(parseAvailability(null).summary.ok).toBe(false);
  });

  it('reasonKey maps fallbacks to AiFallback and the rest to AiAssist errors', () => {
    expect(reasonKey('quota')).toEqual({ ns: 'AiFallback', key: 'quota' });
    expect(reasonKey('not_found')).toEqual({ ns: 'AiAssist', key: 'errors.notFound' });
    expect(reasonKey('weird')).toEqual({ ns: 'AiAssist', key: 'errors.failed' });
  });
});
