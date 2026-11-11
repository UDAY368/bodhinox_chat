// Stage 5 (5G): the pure rules of AI goals (no database, no provider), shared
// by the runtime (lib/ai/goals.ts), the step validator (lib/flows/ai-reply-node.ts),
// the AI settings parser and the editors. Safe to import from client code.

import { AI_GOAL_LIMITS, AI_GOAL_TYPES, AI_LEAD_FIELDS, type AiGoal } from '@/lib/flows/types';

/** Run variables the goals keep (all strings). */
export const GOAL_VARS = {
  /** Index of the goal being worked on. */
  step: 'ai_goal_step',
  /** Goal answers sent by this step (bounded by GOAL_MAX_TURNS). */
  turns: 'ai_goal_turns',
  /** "1" once the link of the current share_link goal was sent. */
  linkShared: 'ai_goal_link_shared',
} as const;

/** After this many answers on one step the remaining goals are given up and the step finishes. */
export const GOAL_MAX_TURNS = 10;

const CUSTOM_FIELD = /^custom:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The custom field id of a `custom:<id>` lead field, or null. */
export function customFieldId(field: string): string | null {
  return CUSTOM_FIELD.exec(field)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Validation (shared by the step validator, the AI settings parser and the form)

/** Why a goal list is invalid, as a fixed code, or null when it is valid. */
export function goalsProblem(value: unknown): 'not_list' | 'too_many' | 'type' | 'url' | 'fields' | 'refusal' | 'duplicate' | null {
  if (!Array.isArray(value)) return 'not_list';
  if (value.length > AI_GOAL_LIMITS.goals) return 'too_many';
  const seen = new Set<string>();
  for (const raw of value) {
    const goal = raw as Partial<AiGoal> & Record<string, unknown> | null;
    if (!goal || typeof goal !== 'object' || !(AI_GOAL_TYPES as readonly string[]).includes(String(goal.type))) return 'type';
    if (seen.has(String(goal.type))) return 'duplicate';
    seen.add(String(goal.type));
    if (goal.type === 'share_link') {
      if (typeof goal.url !== 'string' || goal.url.length > 2048 || !isHttpUrl(goal.url)) return 'url';
      if (goal.label !== undefined && (typeof goal.label !== 'string' || goal.label.length > 80)) return 'url';
    }
    if (goal.type === 'capture_lead') {
      const fields = goal.fields;
      if (!Array.isArray(fields) || fields.length < 1 || fields.length > AI_GOAL_LIMITS.leadFields
        || new Set(fields).size !== fields.length || !fields.every(isLeadField)) return 'fields';
      if (goal.on_refusal !== 'handoff' && goal.on_refusal !== 'continue') return 'refusal';
    }
  }
  return null;
}

/** The goals of a stored config, or [] when they are absent or invalid (the validator refuses invalid ones). */
export function parseGoals(value: unknown): AiGoal[] {
  return goalsProblem(value) === null ? (value as AiGoal[]) : [];
}

export function isLeadField(field: unknown): field is string {
  return typeof field === 'string' && ((AI_LEAD_FIELDS as readonly string[]).includes(field) || CUSTOM_FIELD.test(field));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The run variable a lead field is kept in (custom field ids with underscores). */
export function leadVar(field: string): string {
  return `ai_lead_${field.replace(/^custom:/, 'custom_').replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

// ---------------------------------------------------------------------------
// State

export interface GoalState {
  step: number;
  turns: number;
  linkShared: boolean;
}

export function readGoalState(vars: Record<string, unknown>): GoalState {
  const int = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  };
  return { step: int(vars[GOAL_VARS.step]), turns: int(vars[GOAL_VARS.turns]), linkShared: vars[GOAL_VARS.linkShared] === '1' };
}

export function goalStateVars(state: GoalState): Record<string, string> {
  return { [GOAL_VARS.step]: String(state.step), [GOAL_VARS.turns]: String(state.turns), [GOAL_VARS.linkShared]: state.linkShared ? '1' : '0' };
}

/** Lead fields of a capture_lead goal still without a value in the run. */
export function missingLeadFields(goal: Extract<AiGoal, { type: 'capture_lead' }>, vars: Record<string, unknown>): string[] {
  return goal.fields.filter((f) => {
    const v = vars[leadVar(f)];
    return typeof v !== 'string' || !v;
  });
}

export interface GoalFacts {
  /** The stored "follows your account" fact; null when unknown. */
  followsBusiness: boolean | null;
}

/** Whether a goal is already met (or given up) with what is known now. */
export function goalMet(goal: AiGoal, state: GoalState, vars: Record<string, unknown>, facts: GoalFacts): boolean {
  if (goal.type === 'share_link') return state.linkShared;
  if (goal.type === 'grow_followers') return facts.followsBusiness === true;
  return missingLeadFields(goal, vars).length === 0;
}

/** Moves past every goal that is met; the index of the first open one (goals.length when all are done). */
export function advanceGoals(goals: readonly AiGoal[], state: GoalState, vars: Record<string, unknown>, facts: GoalFacts): GoalState {
  let next = { ...state };
  while (next.step < goals.length && goalMet(goals[next.step], next, vars, facts)) next = { ...next, step: next.step + 1, linkShared: false };
  return next;
}

/** The step's instructions for the current goal (the flow author's text plus fixed guidance). Never customer text. */
export function goalInstructions(goal: AiGoal, missing: readonly string[], labels: Record<string, string>): string {
  if (goal.type === 'share_link') {
    const label = goal.label ? ` (${goal.label.replace(/[\r\n]+/g, ' ')})` : '';
    return `Goal: when the person shows interest, share this link${label}: ${goal.url}\nInclude the link exactly as written. Do not invent other links.`;
  }
  if (goal.type === 'grow_followers') {
    return 'Goal: after answering, invite the person in one friendly sentence to follow this Instagram account. Never pressure them or promise rewards that were not stated.';
  }
  const names = missing.map((f) => labels[f] ?? f).join(', ');
  return `Goal: politely ask the person for these details, one or two at a time: ${names}. If they decline, accept it and do not insist.`;
}

// ---------------------------------------------------------------------------
// The AI step's editor fields (goal sentence, task list, context)

/** Cap of the Stage 5 step guidance added below the step's own instructions. */
export const STEP_GUIDANCE_MAX = 5_000;

interface StepFields {
  goal_text?: unknown;
  tasks?: unknown;
  context?: unknown;
}

/**
 * The Stage 5 guidance of an AI step, in this order: the current goal's
 * fixed guidance, the author's goal sentence, the task list and the
 * background. All of it is the flow author's text (never customer text) and
 * none of it is interpolated. Empty when the step has none of these.
 */
export function aiStepGuidance(cfg: StepFields, goalGuidance?: string | null): string {
  const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '');
  const parts: string[] = [];
  if (goalGuidance?.trim()) parts.push(goalGuidance.trim());
  const goal = oneLine(cfg.goal_text, AI_GOAL_LIMITS.goalTextChars);
  if (goal) parts.push(`Conversation goal: ${goal}`);
  const tasks = Array.isArray(cfg.tasks)
    ? cfg.tasks.slice(0, AI_GOAL_LIMITS.tasks).map((t) => oneLine((t as { text?: unknown } | null)?.text, AI_GOAL_LIMITS.taskChars)).filter(Boolean)
    : [];
  if (tasks.length) parts.push(`Work through these tasks in order, one at a time:\n${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
  const context = typeof cfg.context === 'string' ? cfg.context.trim().slice(0, AI_GOAL_LIMITS.contextChars) : '';
  if (context) parts.push(`Background you may use:\n${context}`);
  return parts.join('\n\n').slice(0, STEP_GUIDANCE_MAX);
}

/**
 * Lead fields the step's tasks save to ("save the reply as"): contact fields
 * by name and custom fields as `custom:<id>`, in task order, without repeats.
 */
export function taskLeadFields(tasks: unknown): string[] {
  if (!Array.isArray(tasks)) return [];
  const out: string[] = [];
  for (const task of tasks.slice(0, AI_GOAL_LIMITS.tasks)) {
    const save = (task as { save_to?: { target?: unknown; key?: unknown } } | null)?.save_to;
    if (!save || typeof save.key !== 'string') continue;
    const field = save.target === 'custom_field' ? `custom:${save.key}` : save.target === 'contact_field' ? save.key : '';
    if (isLeadField(field) && !out.includes(field)) out.push(field);
  }
  return out;
}

/**
 * The goals a step works through: its own goals, then (when its tasks save
 * replies to fields that no capture_lead goal already collects) one implicit
 * capture_lead goal for those fields that continues the flow on refusal.
 * 5B runs runGoalTurn when this list is not empty.
 */
export function effectiveGoals(cfg: { goals?: unknown; tasks?: unknown }): AiGoal[] {
  const goals = parseGoals(cfg.goals);
  const collected = new Set(goals.flatMap((g) => (g.type === 'capture_lead' ? g.fields : [])));
  const extra = taskLeadFields(cfg.tasks).filter((f) => !collected.has(f)).slice(0, AI_GOAL_LIMITS.leadFields);
  return extra.length ? [...goals, { type: 'capture_lead', fields: extra, on_refusal: 'continue' }] : goals;
}

// ---------------------------------------------------------------------------
// The workspace's Instagram AI auto-reply goals (ai_workspace_settings.instagram_goals)

/**
 * Extra instructions for the Instagram auto-reply: the first goal not yet met
 * for this conversation (share_link goals are treated as open; the auto-reply
 * keeps no per-conversation goal state). Null when there are no goals.
 */
export function autoReplyGoalInstructions(goals: readonly AiGoal[], facts: GoalFacts,
  contactValues: Record<string, string | null | undefined>, labels: Record<string, string> = {}): { instructions: string; allowedUrls: string[] } | null {
  for (const goal of goals) {
    if (goal.type === 'grow_followers' && facts.followsBusiness === true) continue;
    if (goal.type === 'capture_lead') {
      const missing = goal.fields.filter((f) => !contactValues[f]);
      if (!missing.length) continue;
      return { instructions: goalInstructions(goal, missing, labels), allowedUrls: [] };
    }
    return { instructions: goalInstructions(goal, [], {}), allowedUrls: goal.type === 'share_link' ? [goal.url] : [] };
  }
  return null;
}
