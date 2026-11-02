import { describe, expect, it } from 'vitest';
import type { MessageTemplate, TemplateButton } from '@/types';
import { buildMetaTemplatePayload } from './template-components';
import { buildSendComponents } from './template-send-builder';
import { validateButtons } from './template-validators';
import { emptyButton, patchButton } from '@/components/templates/template-manager-helpers';

const flow = (patch: Partial<Extract<TemplateButton, { type: 'FLOW' }>> = {}): TemplateButton =>
  ({ type: 'FLOW', text: 'Book now', flow_id: '1234567890', navigate_screen: 'START', flow_action: 'navigate', ...patch });

const template = (buttons: TemplateButton[]): MessageTemplate => ({
  id: 't1', user_id: 'u1', name: 'book_visit', category: 'Marketing', language: 'en_US',
  body_text: 'Book your visit', created_at: '2026-01-01T00:00:00Z', buttons,
});

describe('FLOW button validation', () => {
  it('accepts one FLOW button next to other buttons', () => {
    expect(() => validateButtons([{ type: 'QUICK_REPLY', text: 'Later' }, flow()])).not.toThrow();
  });

  it('allows at most one FLOW button', () => {
    expect(() => validateButtons([flow(), flow({ text: 'Again' })])).toThrow();
  });

  it('requires a form, a short label and a well-formed screen and action', () => {
    expect(() => validateButtons([flow({ flow_id: '' })])).toThrow();
    expect(() => validateButtons([flow({ flow_id: 'not-a-meta-id' })])).toThrow();
    expect(() => validateButtons([flow({ text: 'x'.repeat(26) })])).toThrow();
    expect(() => validateButtons([flow({ text: ' ' })])).toThrow();
    expect(() => validateButtons([flow({ navigate_screen: 'lower' })])).toThrow();
    expect(() => validateButtons([flow({ flow_action: 'other' as 'navigate' })])).toThrow();
  });
});

describe('FLOW button for Meta', () => {
  it('is submitted with its flow id, first screen and action', () => {
    const payload = buildMetaTemplatePayload({ name: 'book_visit', category: 'Marketing', language: 'en_US', body_text: 'Book your visit', buttons: [flow()] });
    const buttons = payload.components.find((c) => c.type === 'BUTTONS')?.buttons;
    expect(buttons).toEqual([{ type: 'FLOW', text: 'Book now', flow_id: '1234567890', navigate_screen: 'START', flow_action: 'navigate' }]);
  });

  it('defaults the action to navigate and omits an unset screen', () => {
    const payload = buildMetaTemplatePayload({ name: 'b', category: 'Marketing', language: 'en_US', body_text: 'B',
      buttons: [{ type: 'FLOW', text: 'Open', flow_id: '42' }] });
    expect(payload.components.find((c) => c.type === 'BUTTONS')?.buttons).toEqual([{ type: 'FLOW', text: 'Open', flow_id: '42', flow_action: 'navigate' }]);
  });

  it('sends this send\'s flow token as the button action parameter', () => {
    const components = buildSendComponents(template([{ type: 'QUICK_REPLY', text: 'Later' }, flow()]), { flowTokens: { 1: 'tok_abc' } });
    expect(components).toEqual([
      { type: 'button', sub_type: 'flow', index: '1', parameters: [{ type: 'action', action: { flow_token: 'tok_abc' } }] },
    ]);
  });

  it('never takes a flow token from caller-supplied button values', () => {
    expect(buildSendComponents(template([flow()]), { buttonParams: { 0: 'forged' } })).toEqual([]);
  });
});

describe('FLOW button in the editor', () => {
  it('starts empty and patches only its own fields', () => {
    const blank = emptyButton('FLOW');
    expect(blank).toEqual({ type: 'FLOW', text: '', flow_id: '', flow_action: 'navigate' });
    const picked = patchButton(blank, { text: 'Open', flow_id: '99', navigate_screen: 'MAIN', url: 'https://ignored.example' });
    expect(picked).toEqual({ type: 'FLOW', text: 'Open', flow_id: '99', navigate_screen: 'MAIN', flow_action: 'navigate' });
  });
});
