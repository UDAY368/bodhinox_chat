/**
 * What a rule sends, in order, for the rules builder's phone preview: each
 * message step as the customer would see it, and every other step as a short
 * system line. A condition shows its "yes" path (its "no" path is listed
 * under the step in the builder). Pure and local: nothing is sent.
 */

import type { AutomationStepType } from '@/types';

export interface RulePreviewStep {
  step_type: AutomationStepType;
  step_config: Record<string, unknown>;
  branches?: { yes: RulePreviewStep[]; no: RulePreviewStep[] };
}

export type RulePreviewLine =
  | {
      kind: 'bot';
      text: string;
      header?: string;
      footer?: string;
      buttons?: string[];
      list?: { button: string; rows: Array<{ id: string; title: string; description?: string }> };
      template?: string;
    }
  | { kind: 'system'; step: AutomationStepType };

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const opt = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

function lineOf(step: RulePreviewStep): RulePreviewLine {
  const cfg = step.step_config ?? {};
  switch (step.step_type) {
    case 'send_message':
      return { kind: 'bot', text: str(cfg.text) };
    case 'send_buttons': {
      const buttons = Array.isArray(cfg.buttons) ? (cfg.buttons as Array<{ title?: unknown }>).map((b) => str(b?.title)) : [];
      return { kind: 'bot', text: str(cfg.body), header: opt(cfg.header), footer: opt(cfg.footer), buttons };
    }
    case 'send_list': {
      const sections = Array.isArray(cfg.sections) ? (cfg.sections as Array<{ rows?: unknown }>) : [];
      const rows = sections.flatMap((s) => (Array.isArray(s?.rows) ? (s.rows as Array<{ id?: unknown; title?: unknown; description?: unknown }>) : []))
        .map((r, i) => ({ id: str(r?.id) || `row-${i}`, title: str(r?.title), description: opt(r?.description) }));
      return { kind: 'bot', text: str(cfg.body), header: opt(cfg.header), footer: opt(cfg.footer), list: { button: str(cfg.button_label), rows } };
    }
    case 'send_template':
      return { kind: 'bot', text: '', template: str(cfg.template_name) };
    default:
      return { kind: 'system', step: step.step_type };
  }
}

/** The preview lines for a rule's steps (at most `limit`, so a long rule stays readable). */
export function rulePreview(steps: RulePreviewStep[], limit = 40): RulePreviewLine[] {
  const out: RulePreviewLine[] = [];
  const walk = (list: RulePreviewStep[]) => {
    for (const step of list) {
      if (out.length >= limit) return;
      out.push(lineOf(step));
      if (step.step_type === 'condition' && step.branches) walk(step.branches.yes);
    }
  };
  walk(steps);
  return out;
}
