import { describe, expect, it } from 'vitest';
import {
  automationUsesSecrets,
  findAutomationCycles,
  validateStepsForActivation,
  validateTriggerForActivation,
  webhookHeaderProblem,
  type LoopCandidate,
} from './validate';

const X = 'tag-x', Y = 'tag-y', Z = 'tag-z';
const auto = (id: string, trigger: string | null, adds: string[], extra: LoopCandidate['steps'] = []): LoopCandidate => ({
  id,
  name: id.toUpperCase(),
  trigger_type: trigger ? 'tag_added' : 'new_message_received',
  trigger_config: trigger ? { tag_id: trigger } : {},
  steps: [...adds.map((tag) => ({ step_type: 'add_tag', step_config: { tag_id: tag } })), ...extra],
});

describe('findAutomationCycles', () => {
  it('finds A adds X, B on X adds Y, C on Y adds X, through the candidate', () => {
    const chain = findAutomationCycles(auto('c', Y, [X]), [auto('a', null, [X]), auto('b', X, [Y])]);
    expect(chain).toEqual(['C', 'B', 'C']);
  });

  it('finds a three-automation cycle and names it in order', () => {
    expect(findAutomationCycles(auto('a', Z, [X]), [auto('b', X, [Y]), auto('c', Y, [Z])])).toEqual(['A', 'B', 'C', 'A']);
  });

  it('follows add_tag inside condition branches', () => {
    const candidate = auto('a', Y, [], [{ step_type: 'condition', step_config: {}, branches: { yes: [], no: [{ step_type: 'add_tag', step_config: { tag_id: X } }] } }]);
    expect(findAutomationCycles(candidate, [auto('b', X, [Y])])).toEqual(['A', 'B', 'A']);
  });

  it('flags a self loop (conservative)', () => {
    expect(findAutomationCycles(auto('a', X, [X]), [])).toEqual(['A', 'A']);
  });

  it('is null for a chain that ends, and ignores the stored copy of the candidate', () => {
    expect(findAutomationCycles(auto('a', null, [X]), [auto('b', X, [Y]), auto('c', Y, [])])).toBeNull();
    // The stored (pre-edit) copy of the candidate in `others` is skipped by id.
    expect(findAutomationCycles(auto('a', Y, []), [auto('a', Y, [X]), auto('b', X, [Y])])).toBeNull();
  });

  it('has no assign_conversation or interactive edge', () => {
    const assigns = auto('a', null, [], [
      { step_type: 'assign_conversation', step_config: { mode: 'round_robin' } },
      { step_type: 'send_buttons', step_config: {} },
    ]);
    const onAssigned: LoopCandidate = { id: 'b', name: 'B', trigger_type: 'conversation_assigned', trigger_config: {}, steps: [{ step_type: 'assign_conversation', step_config: {} }] };
    const onReply: LoopCandidate = { id: 'c', name: 'C', trigger_type: 'interactive_reply', trigger_config: { reply_ids: ['x'] }, steps: [{ step_type: 'send_buttons', step_config: {} }] };
    expect(findAutomationCycles(assigns, [onAssigned, onReply])).toBeNull();
  });
});

describe('notify_team validation', () => {
  const step = (step_config: Record<string, unknown>) => validateStepsForActivation([{ step_type: 'notify_team', step_config }]).map((i) => i.path);
  it('accepts an audience and short text with the two allowed placeholders', () => {
    expect(step({ audience: 'admins', text: 'Lead {{contact.name}} via {{ automation.name }}' })).toEqual([]);
  });
  it('refuses other placeholders, long text and a bad audience', () => {
    expect(step({ audience: 'assignee', text: 'Said: {{message.text}}' })).toEqual(['steps[0].text']);
    expect(step({ audience: 'assignee', text: 'x'.repeat(201) })).toEqual(['steps[0].text']);
    expect(step({ audience: 'everyone', text: 'hi' })).toEqual(['steps[0].audience']);
  });
});

describe('send_webhook validation', () => {
  const issues = (cfg: Record<string, unknown>) =>
    validateStepsForActivation([{ step_type: 'send_webhook', step_config: { url: 'https://hooks.example.com/x', ...cfg } }]).map((i) => i.path);

  it('accepts JSON with placeholders inside strings', () => {
    expect(issues({ body_template: '{"text": "{{message.text}}", "tier": "{{workspace.tier}}"}', headers: { 'X-Token': '{{workspace.api_key}}' } })).toEqual([]);
  });
  it('refuses a body that is not JSON once filled', () => {
    expect(issues({ body_template: '{"n": {{vars.count}}}' })).toEqual(['steps[0].body_template']);
  });
  it('refuses CR/LF in a header value and the denied header names', () => {
    expect(issues({ headers: { 'X-A': 'a\r\nX-Injected: 1' } })).toEqual(['steps[0].headers']);
    for (const name of ['Host', 'content-length', 'Transfer-Encoding', 'Connection', 'Cookie']) {
      expect(issues({ headers: { [name]: 'v' } })).toEqual(['steps[0].headers']);
    }
    expect(issues({ headers: { 'bad name': 'v' } })).toEqual(['steps[0].headers']);
  });
  it('refuses a workspace value in the URL', () => {
    expect(issues({ url: 'https://hooks.example.com/{{workspace.api_key}}' })).toEqual(['steps[0].url']);
  });
  it('checks a filled header value at run time too', () => {
    expect(webhookHeaderProblem('X-Token', 'abc')).toBeNull();
    expect(webhookHeaderProblem('X-Token', 'abc\nX: 1')).toBe('value');
    expect(webhookHeaderProblem('Cookie', 'a')).toBe('denied');
  });
});

describe('automationUsesSecrets', () => {
  const secrets = new Set(['api_key']);
  it('sees a secret in a header or the body, in any branch', () => {
    const hook = { step_type: 'send_webhook', step_config: { url: 'https://x.example', headers: { a: '{{ workspace.api_key }}' } } };
    expect(automationUsesSecrets([hook], secrets)).toBe(true);
    expect(automationUsesSecrets([{ step_type: 'condition', step_config: {}, branches: { yes: [hook] } }], secrets)).toBe(true);
  });
  it('ignores non-secret values and other steps', () => {
    expect(automationUsesSecrets([{ step_type: 'send_webhook', step_config: { body_template: '{"t":"{{workspace.tier}}"}' } }], secrets)).toBe(false);
    expect(automationUsesSecrets([{ step_type: 'send_message', step_config: { text: '{{workspace.api_key}}' } }], secrets)).toBe(false);
  });
});

describe('scheduled trigger', () => {
  const SEG = '00000000-0000-4000-8000-000000000051';
  const steps = [{ step_type: 'send_message', step_config: { text: 'hi' } }];
  it('accepts a segment audience and once_per_contact', () => {
    expect(validateTriggerForActivation('time_based', { schedule: '0 9 * * *', audience: { type: 'segment', segmentId: SEG }, once_per_contact: true }, steps)).toEqual([]);
  });
  it('refuses a segment combined with other keys, a bad id, and a non-boolean once_per_contact', () => {
    const paths = (cfg: Record<string, unknown>) => validateTriggerForActivation('time_based', { schedule: '0 9 * * *', ...cfg }, steps).map((i) => i.path);
    expect(paths({ audience: { type: 'segment', segmentId: SEG, excludeTagIds: [SEG] } })).toEqual(['trigger.audience']);
    expect(paths({ audience: { type: 'segment', segmentId: 'nope' } })).toEqual(['trigger.audience']);
    expect(paths({ audience: { type: 'all', segmentId: SEG } })).toEqual(['trigger.audience']);
    expect(paths({ audience: { type: 'all' }, once_per_contact: 'yes' })).toEqual(['trigger.once_per_contact']);
  });
  it('lets an account-level schedule notify the team without recipients', () => {
    expect(validateTriggerForActivation('time_based', { schedule: '0 9 * * *' }, [{ step_type: 'notify_team', step_config: { audience: 'admins', text: 'Daily check' } }])).toEqual([]);
  });
});
