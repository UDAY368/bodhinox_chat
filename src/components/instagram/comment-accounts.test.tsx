// Stage 1: comment-reply rules moved from Settings › Instagram to
// Instagram › Comments with the same data and API. Admins get the editor for a
// live account with the comments permission; members are read-only; an
// account without the permission links back to Settings › Instagram.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { InstagramAccountView } from '@/lib/instagram/connection';

vi.mock('@/components/instagram/comment-rules-editor', () => ({
  CommentRulesEditor: ({ accountId }: { accountId: string }) => <div data-rules-editor={accountId} />,
}));

import { InstagramCommentAccounts, type InstagramStatus } from './comment-accounts';

const account = (over: Partial<InstagramAccountView> = {}): InstagramAccountView => ({
  id: 'acc-1', igUserId: '1784', username: 'shop', name: 'Shop', status: 'active', scopes: [],
  missingScopes: { dm: [], comments: [] }, accessExpiresAt: null, lastWebhookAt: null, lastErrorCode: null,
  unsupportedEventCount: 0, unsupportedEventLastAt: null, connectedAt: null, disconnectedAt: null, connectionKind: 'instagram_login', facebookPageId: null, ...over,
});

const render = (status: InstagramStatus | null, canEdit: boolean, failed = false) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <InstagramCommentAccounts status={status} failed={failed} canEdit={canEdit} onRetry={() => {}} />
    </NextIntlClientProvider>,
  );

describe('Instagram › Comments', () => {
  it('gives admins the rules editor for each live account with the comments permission', () => {
    const html = render({ enabled: true, accounts: [
      account(),
      account({ id: 'acc-2', username: 'nocomments', missingScopes: { dm: [], comments: ['instagram_business_manage_comments'] } }),
      account({ id: 'acc-3', status: 'disconnected' }),
    ] }, true);
    expect(html).toContain('data-rules-editor="acc-1"');
    expect(html).not.toContain('data-rules-editor="acc-2"');
    expect(html).toContain('Settings.instagram.commentsNotEnabled');
    expect(html).toContain('href="/settings?tab=instagram"');
    // A disconnected account is not listed.
    expect(html).not.toContain('data-instagram-account="acc-3"');
  });

  it('is read-only for members: no editor and no settings links', () => {
    const html = render({ enabled: true, accounts: [account()] }, false);
    expect(html).not.toContain('data-rules-editor');
    expect(html).toContain('Settings.instagram.memberReadOnly');
    expect(html).not.toContain('href="/settings?tab=instagram"');
  });

  it('links admins to connect when no account is live, and explains a platform that is off', () => {
    expect(render({ enabled: true, accounts: [] }, true)).toContain('href="/settings?tab=instagram"');
    expect(render({ enabled: false, reason: 'flag_off', accounts: [] }, true)).toContain('Settings.instagram.reasonFlagOff');
    expect(render(null, true, true)).toContain('Settings.instagram.loadFailed');
  });
});
