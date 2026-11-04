import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => true }));

import { AssessmentPanelView, pollAfterRefresh, type AssessmentPanelData } from './assessment-panel';
import { LeadScoreCell, type LeadScoreEntry } from '@/components/contacts/lead-score-cell';

// The catalogue strings for this namespace live in the task's scratch i18n
// until the fold-in merges them; fall back to messages/en.json afterwards.
const catalogue = (): Record<string, unknown> => {
  const en = JSON.parse(readFileSync(`${process.cwd()}/messages/en.json`, 'utf8'));
  if (en.AiAssessment) return { AiAssessment: en.AiAssessment };
  const scratch = process.env.AI_ASSESS_I18N;
  return scratch ? JSON.parse(readFileSync(scratch, 'utf8')).en : {};
};
const messages = catalogue();
const has = Boolean((messages as { AiAssessment?: unknown }).AiAssessment);
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages} onError={() => {}}>{node}</NextIntlClientProvider>);

const assessment = (patch: Partial<AssessmentPanelData> = {}): AssessmentPanelData => ({
  intent: 'purchase', intent_confidence: 82, lead_score: 75, source: 'model', rationale: '<b>Wants two mugs</b>',
  created_at: '2026-11-04T10:00:00.000Z',
  qualification: { purchase_intent: true, asked_price: true, booking_intent: false, route_to_staff: false }, ...patch,
});

describe('AssessmentPanelView', () => {
  it('shows intent, a code-computed score, signals and an advisory note, with output as text', () => {
    const html = render(<AssessmentPanelView enabled assessment={assessment()} onRefresh={() => {}} />);
    expect(html).toContain('75/100');
    expect(html).toContain('&lt;b&gt;Wants two mugs&lt;/b&gt;');
    expect(html).not.toContain('<b>Wants');
    if (has) {
      expect(html).toContain('Wants to buy');
      expect(html).toContain('Buying intent');
      expect(html).toContain('Asked price');
      expect(html).not.toContain('Wants to book');
      expect(html).toContain('Advisory only');
    }
  });

  it('raises the route-to-staff banner for a health topic and shows no score', () => {
    const html = render(<AssessmentPanelView enabled assessment={assessment({
      intent: 'sensitive_health', lead_score: null, source: 'deterministic', rationale: '',
      qualification: { route_to_staff: true },
    })} />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('/100');
    if (has) expect(html).toContain('qualified member of staff');
  });

  it('offers refresh only when the workspace has assessments on', () => {
    expect(render(<AssessmentPanelView enabled assessment={null} onRefresh={() => {}} />)).toContain('<button');
    expect(render(<AssessmentPanelView enabled={false} assessment={assessment()} onRefresh={() => {}} />)).not.toContain('<button');
  });
});

describe('LeadScoreCell', () => {
  const entry = (patch: Partial<LeadScoreEntry> = {}): LeadScoreEntry => ({
    conversation_id: 'c', intent: 'pricing', intent_confidence: 70, lead_score: 72, source: 'model', route_to_staff: false,
    created_at: '2026-11-04T10:00:00.000Z', ...patch,
  });
  it('renders the score, the staff marker, or nothing', () => {
    expect(render(<LeadScoreCell entry={entry()} />)).toContain('>72<');
    expect(render(<LeadScoreCell entry={entry({ route_to_staff: true, lead_score: null })} />)).toContain('text-destructive');
    expect(render(<LeadScoreCell entry={entry({ lead_score: null, source: 'deterministic' })} />)).toBe('');
    expect(render(<LeadScoreCell entry={undefined} />)).toBe('');
  });
});

describe('pollAfterRefresh', () => {
  it('re-reads after a queued refresh until the stored assessment changes, then stops', async () => {
    vi.useFakeTimers();
    try {
      const reads = ['2026-11-04T10:00:00.000Z', '2026-11-04T10:05:00.000Z'];
      const read = vi.fn(async () => reads.shift() ?? 'later');
      pollAfterRefresh(read, '2026-11-04T10:00:00.000Z', [10, 10, 10]);
      await vi.advanceTimersByTimeAsync(10);
      expect(read).toHaveBeenCalledTimes(1); // unchanged: keep polling
      await vi.advanceTimersByTimeAsync(10);
      expect(read).toHaveBeenCalledTimes(2); // changed: stop
      await vi.advanceTimersByTimeAsync(100);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is bounded and can be cancelled', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => 'same');
      pollAfterRefresh(read, 'same', [10, 10, 10]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(3);
      const read2 = vi.fn(async () => 'same');
      const cancel = pollAfterRefresh(read2, 'same', [10, 10]);
      cancel();
      await vi.advanceTimersByTimeAsync(1000);
      expect(read2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
