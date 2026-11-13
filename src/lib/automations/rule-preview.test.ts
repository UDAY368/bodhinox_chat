import { describe, expect, it } from 'vitest';
import { rulePreview, type RulePreviewStep } from './rule-preview';

const step = (step_type: RulePreviewStep['step_type'], step_config: Record<string, unknown> = {}, branches?: RulePreviewStep['branches']) =>
  ({ step_type, step_config, branches });

describe('rulePreview', () => {
  it('shows messages as the customer sees them and other steps as system lines, in order', () => {
    const lines = rulePreview([
      step('send_message', { text: 'Hi {{name}}' }),
      step('add_tag', { tag_id: 't' }),
      step('send_buttons', { kind: 'buttons', body: 'Pick one', footer: 'Reply below', buttons: [{ id: 'a', title: 'Yes' }, { id: 'b', title: 'No' }] }),
      step('send_template', { template_name: 'order_update' }),
    ]);
    expect(lines).toEqual([
      { kind: 'bot', text: 'Hi {{name}}' },
      { kind: 'system', step: 'add_tag' },
      { kind: 'bot', text: 'Pick one', header: undefined, footer: 'Reply below', buttons: ['Yes', 'No'] },
      { kind: 'bot', text: '', template: 'order_update' },
    ]);
  });

  it('lists a list message with its rows', () => {
    const [line] = rulePreview([step('send_list', { body: 'Menu', button_label: 'Open', sections: [{ rows: [{ id: 'r1', title: 'Prices' }] }] })]);
    expect(line).toMatchObject({ kind: 'bot', text: 'Menu', list: { button: 'Open', rows: [{ id: 'r1', title: 'Prices' }] } });
  });

  it('follows a condition into its yes path only', () => {
    const lines = rulePreview([step('condition', {}, { yes: [step('send_message', { text: 'yes' })], no: [step('send_message', { text: 'no' })] })]);
    expect(lines).toEqual([{ kind: 'system', step: 'condition' }, { kind: 'bot', text: 'yes' }]);
  });

  it('copes with a malformed config and caps a long rule', () => {
    expect(rulePreview([step('send_buttons', { buttons: 'nope' })])[0]).toMatchObject({ kind: 'bot', text: '', buttons: [] });
    expect(rulePreview(Array.from({ length: 60 }, () => step('wait')), 10)).toHaveLength(10);
  });
});
