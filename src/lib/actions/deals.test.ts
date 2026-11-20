import { describe, expect, it } from 'vitest';

import { dealThatStartedRun } from './deals';
import { actionProblem } from '@/lib/flows/stage5-validation';
import { validateStepsForActivation } from '@/lib/automations/validate';
import { automationStepAvailableOn } from '@/lib/channels/capabilities';

const P = '11111111-1111-4111-8111-111111111111';
const S = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';

describe('deal actions', () => {
  it('knows the deal whose own move started a rule or flow run (loop guard)', () => {
    expect(dealThatStartedRun({ event: { type: 'deal.stage_changed', data: { deal_id: D } } })).toBe(D);
    expect(dealThatStartedRun({ event: { type: 'order.paid', data: { deal_id: D } } })).toBeNull();
    expect(dealThatStartedRun({ vars: { event_deal_id: D } })).toBe(D);
    expect(dealThatStartedRun({ vars: { event_deal_id: 'not-an-id' } })).toBeNull();
    expect(dealThatStartedRun({})).toBeNull();
  });

  it('validates the flow deal actions', () => {
    expect(actionProblem({ type: 'create_deal', pipeline_id: P, stage_id: S, title: 'Order {{vars.event_order_id}}' })).toBeNull();
    expect(actionProblem({ type: 'create_deal', pipeline_id: P, stage_id: S, title: ' ' })).not.toBeNull();
    expect(actionProblem({ type: 'create_deal', pipeline_id: P, stage_id: 'x', title: 'T' })).not.toBeNull();
    expect(actionProblem({ type: 'move_deal_stage', pipeline_id: P, stage_id: S, status: 'won' })).toBeNull();
    expect(actionProblem({ type: 'move_deal_stage', pipeline_id: P, stage_id: S, status: 'maybe' })).not.toBeNull();
  });

  it('validates the rule move_deal_stage step, offered on both channels', () => {
    expect(validateStepsForActivation([{ step_type: 'move_deal_stage', step_config: { pipeline_id: P, stage_id: S } }])).toEqual([]);
    expect(validateStepsForActivation([{ step_type: 'move_deal_stage', step_config: { pipeline_id: P } }]).map((i) => i.path))
      .toEqual(['steps[0].stage_id']);
    expect(automationStepAvailableOn('move_deal_stage', 'whatsapp')).toBe(true);
    expect(automationStepAvailableOn('move_deal_stage', 'instagram')).toBe(true);
  });
});
