import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import { AdReferralBadge, AdReferralBadgeView, type AdReferralView } from './ad-referral-badge';

const messages = {
  Inbox: {
    adReferral: {
      startedFromAd: 'Started from ad: {headline}',
      startedFromAdNoHeadline: 'Started from an ad',
      startedFromPost: 'Started from a Facebook or Instagram post',
      viewAd: 'View ad',
    },
  },
};
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
const referral = (patch: Partial<AdReferralView> = {}): AdReferralView =>
  ({ headline: 'Summer sale', source_url: 'https://fb.me/abc', source_type: 'ad', created_at: '2026-11-01T00:00:00.000Z', ...patch });

describe('AdReferralBadge', () => {
  it('shows the ad headline and a safe link to the ad', () => {
    const html = render(<AdReferralBadgeView referral={referral()} />);
    expect(html).toContain('Started from ad: Summer sale');
    expect(html).toContain('href="https://fb.me/abc"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('falls back when there is no headline, and names posts', () => {
    expect(render(<AdReferralBadgeView referral={referral({ headline: null })} />)).toContain('Started from an ad');
    expect(render(<AdReferralBadgeView referral={referral({ source_type: 'post' })} />)).toContain('Facebook or Instagram post');
  });

  it('never links a non-web URL', () => {
    for (const source_url of ['javascript:alert(1)', 'data:text/html,x', 'not a url', null]) {
      const html = render(<AdReferralBadgeView referral={referral({ source_url })} />);
      expect(html).not.toContain('href=');
      expect(html).not.toContain('View ad');
    }
  });

  it('renders nothing until the referral has loaded', () => {
    expect(render(<AdReferralBadge conversationId="11111111-1111-4111-8111-111111111111" />)).toBe('');
  });
});
