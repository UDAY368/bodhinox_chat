import type { MessageTemplate } from '@/types';
import type { DataClient } from '@/lib/data/types';
import { getT } from '@/lib/i18n/translate';
import {
  templateSendNeeds,
  templateSendRefusal,
} from '@/lib/whatsapp/template-send-params';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { ValidationIssue } from './validate';

const t = getT('Validation.automations');

type CheckedTemplate = Pick<
  MessageTemplate,
  'body_text' | 'header_type' | 'header_content' | 'buttons' | 'template_kind' | 'cards' | 'lto'
>;

/**
 * Why an automation send_template step cannot send `template`, or null.
 *
 * The step only carries body values (`variables`), so any template that
 * needs another send-time value would fail on every run: authentication
 * codes, carousels, limited-time offers, a location header, a header
 * variable or a URL button variable. The builder hides these, the save
 * routes refuse them and the engine refuses them before reaching Meta.
 * No server-only imports: the builder uses this too.
 */
export function automationTemplateRefusal(
  template: CheckedTemplate | null | undefined,
): string | null {
  if (!template) return null;
  const auth = templateSendRefusal(template, 'automation');
  if (auth) return auth;
  const needs = templateSendNeeds(template);
  if (needs.kind === 'carousel') return t('templateCarousel');
  if (needs.kind === 'limited_time_offer') return t('templateLimitedTimeOffer');
  if (needs.location) return t('templateLocationHeader');
  if (needs.headerVarCount > 0) return t('templateHeaderVariable');
  if (needs.urlButtons.length > 0) return t('templateUrlVariable');
  return null;
}

interface StepLike {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: StepLike[]; no?: StepLike[] };
}

/**
 * Save-time check: every send_template step (branches included) whose
 * template, picked the way the engine picks it, cannot be sent by an
 * automation. A step naming no stored template is left to the
 * activation checks.
 */
export async function automationTemplateIssues(
  db: DataClient,
  accountId: string,
  steps: StepLike[] | null | undefined,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const visit = async (list: StepLike[], prefix: string): Promise<void> => {
    for (const [i, step] of list.entries()) {
      const path = `${prefix}steps[${i}]`;
      const cfg = step.step_config ?? {};
      if (step.step_type === 'send_template' && typeof cfg.template_name === 'string' && cfg.template_name.trim()) {
        const { row } = await resolveTemplateRow(
          db,
          accountId,
          cfg.template_name,
          typeof cfg.language === 'string' ? cfg.language : undefined,
        );
        const refusal = automationTemplateRefusal(row as CheckedTemplate | null);
        if (refusal) issues.push({ path: `${path}.template_name`, message: refusal });
      }
      if (step.step_type === 'condition' && step.branches) {
        if (step.branches.yes) await visit(step.branches.yes, `${path}.yes.`);
        if (step.branches.no) await visit(step.branches.no, `${path}.no.`);
      }
    }
  };
  if (Array.isArray(steps)) await visit(steps, '');
  return issues;
}
