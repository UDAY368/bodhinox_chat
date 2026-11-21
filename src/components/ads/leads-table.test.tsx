import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRole } from '@/lib/auth/roles';

const auth = vi.hoisted(() => ({ role: null as AccountRole | null }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountRole: auth.role }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import type { LeadDto } from '@/lib/meta-ads/leads';
import { LeadsTable, createRequestSequencer, leadSummary } from './leads-table';

const render = (canManage: boolean) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <ConfirmProvider>
        <LeadsTable canManage={canManage} />
      </ConfirmProvider>
    </NextIntlClientProvider>,
  );

describe('LeadsTable', () => {
  beforeEach(() => {
    auth.role = null;
  });

  it('hides "Broadcast to these leads" from viewers, who cannot create segments', () => {
    auth.role = 'viewer';
    expect(render(false)).not.toContain('Ads.broadcastLeads');
  });

  it('shows "Broadcast to these leads" to agents and above', () => {
    for (const role of ['agent', 'admin', 'owner'] as const) {
      auth.role = role;
      expect(render(role !== 'agent')).toContain('Ads.broadcastLeads');
    }
  });

  it('keeps CSV export to admins', () => {
    auth.role = 'agent';
    expect(render(false)).not.toContain('Ads.exportCsv');
    auth.role = 'admin';
    expect(render(true)).toContain('Ads.exportCsv');
  });
});

describe('createRequestSequencer', () => {
  it('lets only the latest request update state', () => {
    const seq = createRequestSequencer();
    const first = seq.next();
    const second = seq.next();
    // The older response arrives last and must be dropped.
    expect(seq.isCurrent(second)).toBe(true);
    expect(seq.isCurrent(first)).toBe(false);
    const third = seq.next();
    expect(seq.isCurrent(second)).toBe(false);
    expect(seq.isCurrent(third)).toBe(true);
  });
});

describe('leadSummary (phone rows)', () => {
  const base: LeadDto = {
    id: 'l1', leadgenId: 'g1', formId: 'f1', formName: 'Spring form', adId: '42', adName: null, campaignName: null,
    status: 'fetched', answers: [{ name: 'email', values: ['a@example.com'] }, { name: 'city', values: ['Pune', 'Mumbai'] }],
    contactId: null, contactName: null, leadCreatedAt: null, receivedAt: '2026-11-20T10:00:00.000Z',
  };

  it('lists the form, the ad and the answers after the time', () => {
    const text = leadSummary(base, (k) => k);
    expect(text).toContain('Spring form · 42 · a@example.com · Pune, Mumbai');
  });

  it('says why a lead has no answers yet', () => {
    expect(leadSummary({ ...base, status: 'pending', answers: [] }, (k) => k)).toContain('leads.status.pending');
  });
});
