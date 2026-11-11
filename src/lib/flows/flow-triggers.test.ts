import { describe, expect, it } from 'vitest';
import { effectiveTriggers, effectiveTriggerTypes } from './flow-triggers';
import { COMBINABLE_TRIGGERS, FLOW_TRIGGER_LIMITS, FLOW_TRIGGER_TYPES, isCombinableTrigger } from './types';

describe('effectiveTriggers (Stage 5)', () => {
  it('returns only the primary trigger for a flow without extra triggers (every flow before Stage 5)', () => {
    expect(effectiveTriggers({ trigger_type: 'keyword', trigger_config: { keywords: ['hi'] } }))
      .toEqual([{ trigger_type: 'keyword', config: { keywords: ['hi'] } }]);
    expect(effectiveTriggers({ trigger_type: 'manual', trigger_config: null, extra_triggers: [] }))
      .toEqual([{ trigger_type: 'manual', config: {} }]);
  });

  it('lists the primary first, then each extra trigger in stored order', () => {
    const triggers = effectiveTriggers({
      trigger_type: 'ig_comment',
      trigger_config: { post_scope: 'any' },
      extra_triggers: [
        { trigger_type: 'keyword', config: { keywords: ['guide'] } },
        { trigger_type: 'ig_story_reply', config: {} },
      ],
    });
    expect(triggers.map((t) => t.trigger_type)).toEqual(['ig_comment', 'keyword', 'ig_story_reply']);
    expect(triggers[1].config).toEqual({ keywords: ['guide'] });
  });

  it('skips malformed, unknown and duplicate entries instead of failing', () => {
    const triggers = effectiveTriggers({
      trigger_type: 'keyword',
      trigger_config: { keywords: ['a'] },
      extra_triggers: [null, 'keyword', { trigger_type: 'nope' }, { config: {} },
        { trigger_type: 'keyword', config: { keywords: ['a'] } },
        { trigger_type: 'ig_ref', config: { refs: ['x'] } },
        { trigger_type: 'ig_ref', config: { refs: ['x'] } },
        { trigger_type: 'ig_comment', config: 'not an object' }],
    });
    expect(triggers).toEqual([
      { trigger_type: 'keyword', config: { keywords: ['a'] } },
      { trigger_type: 'ig_ref', config: { refs: ['x'] } },
      { trigger_type: 'ig_comment', config: {} },
    ]);
  });

  it('ignores extra_triggers that is not an array, and an unknown primary type', () => {
    expect(effectiveTriggers({ trigger_type: 'keyword', trigger_config: {}, extra_triggers: { trigger_type: 'ig_ref' } }))
      .toHaveLength(1);
    expect(effectiveTriggers({ trigger_type: 'gone', trigger_config: {}, extra_triggers: [{ trigger_type: 'ig_ref', config: {} }] }))
      .toEqual([{ trigger_type: 'ig_ref', config: {} }]);
  });

  it('effectiveTriggerTypes lists distinct types, primary first', () => {
    expect(effectiveTriggerTypes({ trigger_type: 'keyword', trigger_config: {}, extra_triggers: [
      { trigger_type: 'keyword', config: { keywords: ['b'] } }, { trigger_type: 'ad_click', config: {} }] }))
      .toEqual(['keyword', 'ad_click']);
  });

  it('combines only known trigger types, never default_reply or manual', () => {
    for (const trigger of COMBINABLE_TRIGGERS) expect(FLOW_TRIGGER_TYPES).toContain(trigger);
    expect(isCombinableTrigger('default_reply')).toBe(false);
    expect(isCombinableTrigger('manual')).toBe(false);
    expect(isCombinableTrigger('first_inbound_message')).toBe(false);
    expect(isCombinableTrigger('ig_comment')).toBe(true);
    expect(FLOW_TRIGGER_LIMITS.extraTriggers + 1).toBe(5);
  });
});
