import { describe, expect, it } from 'vitest';
import { statusTone } from './ads-ui';
import { setupSteps } from './ads-setup-checklist';

describe('statusTone', () => {
  it('groups Meta statuses into plain words', () => {
    expect(statusTone('ACTIVE')).toBe('active');
    expect(statusTone('ADSET_PAUSED')).toBe('paused');
    expect(statusTone('PENDING_REVIEW')).toBe('review');
    expect(statusTone('DISAPPROVED')).toBe('rejected');
    expect(statusTone('WITH_ISSUES')).toBe('issues');
    expect(statusTone('ARCHIVED')).toBe('ended');
    expect(statusTone('PENDING_BILLING_INFO')).toBe('billing');
    expect(statusTone('SOMETHING_NEW')).toBe('other');
    expect(statusTone(null)).toBe('other');
  });
});

describe('setupSteps', () => {
  const base = { connected: true, adAccounts: 1, pageId: 'p1', manageEnabled: true, missingScopes: [] as string[] };

  it('is all done for a fully set-up workspace', () => {
    expect(setupSteps(base).every((s) => s.done)).toBe(true);
  });

  it('marks each missing piece, and permissions only count once ad creation is on', () => {
    const steps = setupSteps({ ...base, adAccounts: 0, pageId: null, missingScopes: ['ads_management'] });
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(['adAccount', 'page', 'permissions']);
    expect(setupSteps({ ...base, manageEnabled: false }).find((s) => s.key === 'permissions')?.done).toBe(false);
    expect(setupSteps(base).find((s) => s.key === 'manage')?.href).toBeNull();
  });
});
