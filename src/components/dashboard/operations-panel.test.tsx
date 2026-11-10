import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, it } from 'vitest';
import messages from '../../../messages/en.json';
import type { DashboardOperations } from '@/lib/dashboard/operations-types';
import { OperationsContent } from './operations-panel';

const empty: DashboardOperations = {
  days: 30,
  replyTargetMinutes: 15,
  attention: {
    waiting: 0,
    overTarget: 0,
    unassigned: 0,
    expiring: 0,
    failed: 0,
  },
  queue: [],
  failedMessages: [],
  team: [],
  automated: { replies: 0, medianMinutes: null },
  pipelines: [],
  campaigns: {
    automationRuns: 0,
    automationFailed: 0,
    flowFailed: 0,
    topFailingFlow: null,
    templatesApproved: 0,
    templatesRejected: 0,
  },
  latestBroadcast: null,
  setup: {
    whatsapp: false,
    contacts: false,
    template: false,
    teammate: false,
    conversation: false,
  },
};
const render = (data: DashboardOperations, whatsapp?: boolean) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <OperationsContent data={data} whatsapp={whatsapp} />
    </NextIntlClientProvider>
  );

it('offers actionable inbox filters and honest empty states with no fabricated response time', () => {
  const html = render(empty);
  for (const text of [
    'filter=waiting',
    'filter=unassigned',
    'filter=expiring-soon',
    'No customers are waiting',
    'No failed messages',
    'No pipelines yet',
    'No broadcasts yet',
    'Automated replies',
    'Reply target: 15 minutes',
  ])
    expect(html).toContain(text);
  expect(html).toContain('—');
  expect(html).not.toContain('0 min');
});

it('links queues and failures to conversations and shows human and automated metrics separately', () => {
  const at = '2026-10-24T10:00:00Z';
  const html = render({
    ...empty,
    queue: [
      {
        id: 'c/one',
        name: 'Waiting customer',
        waitingSince: at,
        closesAt: at,
        assigned: false,
        handedOff: true,
      },
    ],
    failedMessages: [
      {
        id: 'failure',
        conversationId: 'c/two',
        name: 'Failed customer',
        preview: '<script>unsafe</script>',
        at,
      },
    ],
    team: [
      {
        id: 'agent',
        name: 'Human agent',
        open: 2,
        replies: 3,
        medianMinutes: 4,
      },
    ],
    automated: { replies: 7, medianMinutes: 0.5 },
    pipelines: [
      {
        id: 'pipe',
        name: 'Sales',
        open: 1,
        won: 2,
        lost: 3,
        idle: 4,
        avgDaysToWin: 2.5,
      },
    ],
  });
  for (const text of [
    'c=c%2Fone',
    'c=c%2Ftwo',
    'Handed off',
    'Human agent',
    '4 min',
    '0.5 min',
    'Sales',
    'Average days to win: 2.5',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});

it('leaves out the WhatsApp setup steps for a workspace that does not use WhatsApp', () => {
  const withWhatsApp = render(empty);
  expect(withWhatsApp).toContain('href="/settings?tab=whatsapp"');
  expect(withWhatsApp).toContain('href="/settings?tab=templates"');
  const without = render(empty, false);
  expect(without).not.toContain('href="/settings?tab=whatsapp"');
  expect(without).not.toContain('href="/settings?tab=templates"');
  expect(without).toContain('href="/contacts"');
  expect(without).toContain('href="/settings?tab=members"');
});
