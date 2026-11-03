import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRole } from '@/lib/auth/roles';

const auth = vi.hoisted(() => ({ role: null as AccountRole | null }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountRole: auth.role }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import { LeadsTable, createRequestSequencer } from './leads-table';

const render = (canManage: boolean) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <LeadsTable canManage={canManage} />
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
