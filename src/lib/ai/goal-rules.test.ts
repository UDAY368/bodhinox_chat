import { describe, expect, it } from 'vitest';
import type { AiGoal } from '@/lib/flows/types';
import {
  advanceGoals, aiStepGuidance, autoReplyGoalInstructions, autoReplyGoalsProblem, effectiveGoals, goalInstructions, goalsProblem, goalStateVars, leadVar,
  missingLeadFields, parseGoals, readGoalState, STEP_GUIDANCE_MAX, taskLeadFields,
} from './goal-rules';

const FIELD = '0f8fad5b-d9cb-469f-a165-70867728950e';
const link: AiGoal = { type: 'share_link', url: 'https://shop.example/offer', label: 'Spring offer' };
const follow: AiGoal = { type: 'grow_followers' };
const lead: AiGoal = { type: 'capture_lead', fields: ['email', `custom:${FIELD}`], on_refusal: 'handoff' };

describe('goalsProblem', () => {
  it('accepts up to three distinct, complete goals', () => {
    expect(goalsProblem([])).toBeNull();
    expect(goalsProblem([link, follow, lead])).toBeNull();
  });
  it.each([
    ['not a list', {}, 'not_list'],
    ['too many', [link, follow, lead, link], 'too_many'],
    ['unknown type', [{ type: 'buy' }], 'type'],
    ['repeated type', [follow, follow], 'duplicate'],
    ['javascript link', [{ type: 'share_link', url: 'javascript:alert(1)' }], 'url'],
    ['link with credentials', [{ type: 'share_link', url: 'https://u:p@x.example' }], 'url'],
    ['long label', [{ type: 'share_link', url: 'https://x.example', label: 'x'.repeat(81) }], 'url'],
    ['no fields', [{ type: 'capture_lead', fields: [], on_refusal: 'continue' }], 'fields'],
    ['unknown field', [{ type: 'capture_lead', fields: ['password'], on_refusal: 'continue' }], 'fields'],
    ['repeated field', [{ type: 'capture_lead', fields: ['email', 'email'], on_refusal: 'continue' }], 'fields'],
    ['too many fields', [{ type: 'capture_lead', fields: ['name', 'email', 'phone', 'company', `custom:${FIELD}`, `custom:${FIELD.replace('0f', '1f')}`], on_refusal: 'continue' }], 'fields'],
    ['no refusal rule', [{ type: 'capture_lead', fields: ['email'] }], 'refusal'],
  ])('refuses %s', (_name, value, code) => {
    expect(goalsProblem(value)).toBe(code);
  });
  it('parseGoals drops an invalid list entirely', () => {
    expect(parseGoals([follow, { type: 'nope' }])).toEqual([]);
    expect(parseGoals(null)).toEqual([]);
  });
});

describe('goal order and state', () => {
  it('works through goals in order and skips the ones already met', () => {
    const goals = [follow, link, lead];
    const start = readGoalState({});
    expect(advanceGoals(goals, start, {}, { followsBusiness: null }).step).toBe(0);
    // Already following: the first open goal is the link.
    expect(advanceGoals(goals, start, {}, { followsBusiness: true }).step).toBe(1);
    // Link shared: on to the lead.
    expect(advanceGoals(goals, { ...start, step: 1, linkShared: true }, {}, { followsBusiness: true }).step).toBe(2);
    // Every lead field captured: done.
    const vars = { [leadVar('email')]: 'a@b.example', [leadVar(`custom:${FIELD}`)]: 'Pune' };
    expect(advanceGoals(goals, { ...start, step: 2 }, vars, { followsBusiness: true }).step).toBe(3);
  });
  it('round-trips state through run variables and ignores junk', () => {
    const state = { step: 2, turns: 4, linkShared: true };
    expect(readGoalState(goalStateVars(state))).toEqual(state);
    expect(readGoalState({ ai_goal_step: '-1', ai_goal_turns: 'x' })).toEqual({ step: 0, turns: 0, linkShared: false });
  });
  it('lists the lead fields still missing', () => {
    expect(missingLeadFields(lead as Extract<AiGoal, { type: 'capture_lead' }>, { [leadVar('email')]: 'a@b.example' })).toEqual([`custom:${FIELD}`]);
  });
});

describe('instructions', () => {
  it('names the link exactly and the missing details by label', () => {
    expect(goalInstructions(link, [], {})).toContain('https://shop.example/offer');
    expect(goalInstructions(lead, ['email'], { email: 'email address' })).toContain('email address');
  });
  it('the Instagram auto-reply gets the first open goal only, with the link allowed', () => {
    expect(autoReplyGoalInstructions([], { followsBusiness: null }, {})).toBeNull();
    const next = autoReplyGoalInstructions([follow, link], { followsBusiness: true }, {});
    expect(next?.allowedUrls).toEqual(['https://shop.example/offer']);
    expect(autoReplyGoalInstructions([lead], { followsBusiness: null }, { email: 'a@b.example', [`custom:${FIELD}`]: 'x' })).toBeNull();
  });
  it('the auto-reply moves past a link already sent in the conversation to the next goal', () => {
    const shared = new Set(['https://shop.example/offer']);
    expect(autoReplyGoalInstructions([link, lead], { followsBusiness: null }, {})?.allowedUrls).toEqual(['https://shop.example/offer']);
    const next = autoReplyGoalInstructions([link, lead], { followsBusiness: null }, {}, { email: 'email address' }, shared);
    expect(next?.allowedUrls).toEqual([]);
    expect(next?.instructions).toContain('email address');
    expect(autoReplyGoalInstructions([link], { followsBusiness: null }, {}, {}, shared)).toBeNull();
  });
  it('the auto-reply never asks for a phone (it could never be stored, so it would be asked forever)', () => {
    expect(autoReplyGoalsProblem([lead])).toBeNull();
    expect(autoReplyGoalsProblem([{ type: 'capture_lead', fields: ['email', 'phone'], on_refusal: 'continue' }])).toBe('fields');
    expect(autoReplyGoalsProblem({})).toBe('not_list');
  });
});

describe('AI step editor fields', () => {
  it('joins goal guidance, goal sentence, numbered tasks and context in that order, one line per task', () => {
    const text = aiStepGuidance({ goal_text: 'Help pick a plan', tasks: [{ text: 'Ask the budget' }, { text: 'Line\nbreak' }], context: 'Plans: A, B' }, 'Goal: x');
    expect(text.indexOf('Goal: x')).toBeLessThan(text.indexOf('Help pick a plan'));
    expect(text).toContain('1. Ask the budget');
    expect(text).toContain('2. Line break');
    expect(text).toContain('Plans: A, B');
    expect(aiStepGuidance({})).toBe('');
    expect(aiStepGuidance({ context: 'x'.repeat(9000), goal_text: 'y'.repeat(900) }).length).toBeLessThanOrEqual(STEP_GUIDANCE_MAX);
  });
  it('tasks that save replies become an implicit lead goal after the step goals', () => {
    const tasks = [
      { text: 'Ask the email', save_to: { target: 'contact_field', key: 'email' } },
      { text: 'Ask the city', save_to: { target: 'custom_field', key: FIELD } },
      { text: 'Bad', save_to: { target: 'contact_field', key: 'password' } },
    ];
    expect(taskLeadFields(tasks)).toEqual(['email', `custom:${FIELD}`]);
    expect(effectiveGoals({ tasks })).toEqual([{ type: 'capture_lead', fields: ['email', `custom:${FIELD}`], on_refusal: 'continue' }]);
    // A field the step's own lead goal collects is not asked twice.
    expect(effectiveGoals({ goals: [lead], tasks })).toEqual([lead]);
    expect(effectiveGoals({})).toEqual([]);
  });
});
