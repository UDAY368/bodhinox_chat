import { expect, it } from 'vitest';
import { addableStepsFor, fromServerSteps, toApiSteps, triggerOptionsFor } from './automation-builder';
it('keeps persisted step identities through builder edits and serialization', () => {
  const tree = fromServerSteps([
    {
      id: 'root-id',
      step_type: 'condition',
      step_config: {},
      branches: {
        yes: [
          {
            id: 'child-id',
            step_type: 'wait',
            step_config: {},
            branches: { yes: [], no: [] },
          },
        ],
        no: [],
      },
    },
  ]);
  const payload = toApiSteps(tree);
  expect(payload[0]).toHaveProperty('id', 'root-id');
  expect(payload[0].branches?.yes?.[0]).toHaveProperty('id', 'child-id');
});

it('uses the same identity on repeated saves of a newly added step', () => {
  const tree = [
    {
      cid: 'c_11111111-1111-4111-8111-111111111111',
      step_type: 'wait' as const,
      step_config: {},
    },
  ];
  expect(toApiSteps(tree)[0].id).toBe('11111111-1111-4111-8111-111111111111');
  expect(toApiSteps(tree)[0].id).toBe(toApiSteps(tree)[0].id);
});

it('offers each channel only its palette, in menu order', () => {
  expect(addableStepsFor('whatsapp')).toContain('send_template');
  expect(addableStepsFor('instagram')).not.toContain('send_template');
  expect(addableStepsFor('instagram')).not.toContain('send_list');
  expect(addableStepsFor('instagram')).toContain('send_buttons');
  expect(triggerOptionsFor('whatsapp')).toContain('time_based');
  expect(triggerOptionsFor('instagram')).toEqual([
    'new_message_received', 'first_inbound_message', 'keyword_match', 'interactive_reply',
    'new_contact_created', 'conversation_assigned', 'tag_added',
  ]);
  // A stored trigger outside the palette still shows as itself.
  expect(triggerOptionsFor('instagram', 'time_based')).toContain('time_based');
});
