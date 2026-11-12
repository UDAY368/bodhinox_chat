// The ManyChat-style message editor: the 24-hour switch's conversions and the
// bubble's markup. Behaviour in the editor is covered by e2e/flow-message-composer.spec.ts.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import type { BuilderNode } from '../shared';
import { AddRowButton, MessageBubble, ReplyRow, switchSendWindow } from './message-bubble';

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ key }) => key}>
      {node}
    </NextIntlClientProvider>,
  );
const node = (node_type: BuilderNode['node_type'], config: Record<string, unknown>): BuilderNode => ({ node_key: 'step', node_type, config });

describe('switchSendWindow', () => {
  it('turns a text step into a template step that keeps its next step', () => {
    expect(switchSendWindow(node('send_message', { text: 'Hi', next_node_key: 'after' }), true)).toEqual({
      node_type: 'send_template', config: { template_name: '', body_params: [], buttons: [], next_node_key: 'after' },
    });
  });

  it('turns a template without routed quick replies back into a text step', () => {
    expect(switchSendWindow(node('send_template', { template_name: 'offer', buttons: [], next_node_key: 'after' }), false)).toEqual({
      node_type: 'send_message', config: { text: '', next_node_key: 'after' },
    });
  });

  it('refuses switches that would drop routes: buttons, lists, or a template whose quick replies lead to steps', () => {
    expect(switchSendWindow(node('send_buttons', { text: 'Hi', buttons: [{ reply_id: 'a', title: 'A', next_node_key: 'x' }] }), true)).toBeNull();
    expect(switchSendWindow(node('send_list', { text: 'Hi', sections: [] }), true)).toBeNull();
    expect(switchSendWindow(node('send_template', { template_name: 'offer', buttons: [{ index: 0, reply_id: 'a', title: 'A', next_node_key: 'x' }] }), false)).toBeNull();
  });

  it('keeps the step\'s typing delay across the switch, both ways', () => {
    const toTemplate = switchSendWindow(node('send_message', { text: 'Hi', next_node_key: 'after', delay_seconds: 300 }), true);
    expect(toTemplate?.config).toMatchObject({ delay_seconds: 300, next_node_key: 'after' });
    const back = switchSendWindow(node('send_template', { template_name: 'offer', next_node_key: 'after', delay_seconds: 60 }), false);
    expect(back?.config).toMatchObject({ delay_seconds: 60, next_node_key: 'after' });
    expect(switchSendWindow(node('send_message', { text: 'Hi' }), true)?.config).not.toHaveProperty('delay_seconds');
  });

  it('does nothing when the step is already on that side', () => {
    expect(switchSendWindow(node('send_message', { text: 'Hi' }), false)).toBeNull();
    expect(switchSendWindow(node('send_template', { template_name: 'offer' }), true)).toBeNull();
  });
});

describe('MessageBubble and ReplyRow', () => {
  it('draws the button title in place, centered, with its settings cell marked as connected', () => {
    const html = wrap(
      <MessageBubble>
        <ReplyRow title="Sure!" onTitle={() => {}} titleLabel="Button title" maxLength={20} next="book" onNext={() => {}}
          replyId="yes" onReplyId={() => {}} showAdvanced={false} currentKey="step" removeLabel="Remove button"
          allNodes={[{ node_key: 'book', node_type: 'send_message', config: {} }]} />
        <AddRowButton label="Add button" onClick={() => {}} />
      </MessageBubble>,
    );
    expect(html).toContain('data-bubble=""');
    expect(html).toMatch(/<input[^>]*value="Sure!"[^>]*>/);
    expect(html).toMatch(/<input[^>]*maxLength="20"/);
    expect(html).toContain('text-center');
    expect(html).toContain('data-connected=""');
    expect(html).toContain('Add button');
  });

  it('marks a row that leads nowhere yet as not connected', () => {
    const html = wrap(
      <ReplyRow title="Later" onTitle={() => {}} titleLabel="Button title" maxLength={20} next="" onNext={() => {}}
        replyId="later" onReplyId={() => {}} showAdvanced={false} currentKey="step" removeLabel="Remove button" allNodes={[]} />,
    );
    expect(html).not.toContain('data-connected');
    expect(html).toContain('notConnected');
  });
});
