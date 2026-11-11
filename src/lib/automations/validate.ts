import { isValidTimeWindow, isValidTimeZone } from './time-of-day';
import type { AutomationStepType, AutomationTriggerType, Channel } from '@/types';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { getT } from '@/lib/i18n/translate';
import {
  AUTOMATION_STEPS_BY_CHANNEL,
  AUTOMATION_TRIGGERS_BY_CHANNEL,
  isChannel,
} from '@/lib/channels/capabilities';
import { quickRepliesFit } from '@/lib/instagram/graph-limits';
import {
  parseScheduledAudience,
  scheduleNeedsContact,
  validCronSchedule,
  validScheduleTimezone,
} from './scheduled-contract';

const t = getT('Validation.automations');
const tStartFlow = getT('Automations.steps.startFlow');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/**
 * Stage 5: the fields a field_changed trigger can listen to, the ones the
 * contact field writer emits the event for (src/lib/contacts/field-write.ts):
 * name, email, company or `custom:<custom field id>`.
 */
export const CONTACT_EVENT_FIELDS = ['name', 'email', 'company'] as const;
export function isContactEventField(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if ((CONTACT_EVENT_FIELDS as readonly string[]).includes(value)) return true;
  return value.startsWith('custom:') && isUuid(value.slice('custom:'.length));
}

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string;
  message: string;
}

interface StepLike {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: StepLike[]; no?: StepLike[] };
}

export function validateStepsForActivation(
  steps: StepLike[],
  channel: Channel = 'whatsapp'
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: t('needsStep'),
    });
    return issues;
  }
  walk(steps, '', issues);
  issues.push(...stepPaletteIssues(steps, channel));
  return issues;
}

function walk(
  steps: StepLike[],
  prefix: string,
  issues: ValidationIssue[]
): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`;
    validateOne(s, path, issues);
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues);
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues);
    }
  });
}

function validateOne(
  step: StepLike,
  path: string,
  issues: ValidationIssue[]
): void {
  const c = step.step_config ?? {};
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({
          path: `${path}.text`,
          message: t('messageTextRequired'),
        });
      }
      break;
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c);
      if (!result.ok) {
        issues.push({ path: `${path}.interactive`, message: result.error });
      }
      break;
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({
          path: `${path}.template_name`,
          message: t('templateNameRequired'),
        });
      }
      break;
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: t('tagRequired') });
      }
      break;
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: t('agentRequired'),
        });
      }
      break;
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: t('fieldNameRequired') });
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({
          path: `${path}.value`,
          message: t('fieldValueRequired'),
        });
      }
      break;
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({
          path: `${path}.pipeline_id`,
          message: t('pipelineRequired'),
        });
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: t('stageRequired') });
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: t('titleRequired') });
      }
      break;
    case 'wait':
      if (
        typeof c.amount !== 'number' ||
        !Number.isFinite(c.amount) ||
        c.amount <= 0
      ) {
        issues.push({
          path: `${path}.amount`,
          message: t('waitAmountInvalid'),
        });
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: t('waitUnitInvalid'),
        });
      }
      break;
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({
          path: `${path}.subject`,
          message: t('conditionSubjectRequired'),
        });
      }
      if (c.subject !== 'message_content' && !nonEmpty(c.operand)) {
        issues.push({
          path: `${path}.operand`,
          message: t('conditionOperandRequired'),
        });
      }
      if (
        (c.subject === 'message_content' || c.subject === 'contact_field') &&
        !nonEmpty(c.value)
      ) {
        issues.push({
          path: `${path}.value`,
          message: t('conditionValueRequired'),
        });
      }
      if (c.subject === 'time_of_day') {
        if (nonEmpty(c.operand) && !isValidTimeWindow(c.operand)) {
          issues.push({
            path: `${path}.operand`,
            message: t('conditionTimeRangeInvalid'),
          });
        }
        if (c.timezone !== undefined && !isValidTimeZone(c.timezone)) {
          issues.push({
            path: `${path}.timezone`,
            message: t('conditionTimezoneInvalid'),
          });
        }
      }
      break;
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: t('webhookUrlRequired') });
        break;
      }
      try {
        const u = new URL(String(c.url));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: t('webhookUrlScheme'),
          });
        }
      } catch {
        issues.push({ path: `${path}.url`, message: t('webhookUrlInvalid') });
      }
      issues.push(...webhookConfigIssues(c, path));
      break;
    case 'close_conversation':
      // No config required.
      break;
    case 'notify_team':
      if (c.audience !== 'assignee' && c.audience !== 'admins') {
        issues.push({ path: `${path}.audience`, message: t('notifyAudienceInvalid') });
      }
      if (!nonEmpty(c.text) || String(c.text).length > NOTIFY_TEXT_MAX) {
        issues.push({ path: `${path}.text`, message: t('notifyTextInvalid', { max: NOTIFY_TEXT_MAX }) });
      } else if (notifyTextPlaceholders(String(c.text)).some((p) => !NOTIFY_PLACEHOLDERS.has(p))) {
        issues.push({ path: `${path}.text`, message: t('notifyPlaceholderInvalid') });
      }
      break;
    case 'start_flow':
      // Stage 5: an active flow of this workspace and channel; the engine
      // re-checks both when it runs (startFlowById), so a foreign or paused
      // flow simply does not start.
      if (!isUuid(c.flow_id)) {
        issues.push({ path: `${path}.flow_id`, message: tStartFlow('none') });
      }
      break;
    default:
      issues.push({
        path,
        message: t('unknownStepType', { type: step.step_type }),
      });
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
  steps: StepLike[] = [],
  channel: Channel = 'whatsapp'
): ValidationIssue[] {
  const issues: ValidationIssue[] = [...triggerPaletteIssues(triggerType, channel)];
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>;

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords;
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: t('keywordRequired') });
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: t('keywordsEmpty') });
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (
      cfg.match_type != null &&
      cfg.match_type !== 'exact' &&
      cfg.match_type !== 'contains' &&
      cfg.match_type !== 'word'
    ) {
      issues.push({
        path: 'trigger.match_type',
        message: t('matchTypeInvalid'),
      });
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({ path: 'trigger.schedule', message: t('scheduleRequired') });
    } else if (!validCronSchedule(cfg.schedule)) {
      issues.push({
        path: 'trigger.schedule',
        message:
          'Enter a valid five-field cron expression, for example 0 9 * * *',
      });
    }
    if (cfg.timezone !== undefined && !validScheduleTimezone(cfg.timezone)) {
      issues.push({
        path: 'trigger.timezone',
        message:
          'Choose a valid IANA timezone, for example Asia/Kolkata or UTC',
      });
    }
    if (cfg.once_per_contact !== undefined && typeof cfg.once_per_contact !== 'boolean') {
      issues.push({ path: 'trigger.once_per_contact', message: t('oncePerContactInvalid') });
    }
    if (cfg.audience !== undefined || scheduleNeedsContact(steps)) {
      try {
        parseScheduledAudience(cfg.audience);
      } catch (error) {
        issues.push({
          path: 'trigger.audience',
          message:
            error instanceof Error
              ? error.message
              : 'Choose scheduled recipients',
        });
      }
    }
  } else if (triggerType === 'tag_added' || triggerType === 'tag_removed') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: t('tagRequired') });
    }
  } else if (triggerType === 'field_changed') {
    // Stage 5: a field the contact writers emit field_changed for.
    if (!isContactEventField(cfg.field)) {
      issues.push({ path: 'trigger.field', message: t('fieldNameRequired') });
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: t('replyIdRequired'),
      });
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: t('replyIdsEmpty'),
      });
    }
  } else if (triggerType === 'ad_click') {
    // Optional Meta ad ids: empty or absent runs for any ad.
    const ids = cfg.ad_ids;
    if (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.length > 50 ||
      ids.some((v) => typeof v !== 'string' || !/^\d{1,32}$/.test(v)))) {
      issues.push({ path: 'trigger.ad_ids', message: t('adIdsInvalid', { max: 50 }) });
    }
  } else if (triggerType.startsWith('appointment_')) {
    // Optional service ids: empty or absent runs for every service.
    const ids = cfg.service_ids;
    if (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.length > 50 ||
      ids.some((v) => typeof v !== 'string' || !UUID.test(v)))) {
      issues.push({ path: 'trigger.service_ids', message: t('serviceIdsInvalid', { max: 50 }) });
    }
  }

  return issues;
}

// ------------------------------------------------------------
// Channel palettes (Stage 1): an automation belongs to one channel and may
// use only that channel's triggers and steps (src/lib/channels/capabilities).
// Only known types are judged here; an unknown one stays the job of the
// checks above, so the WhatsApp palette (every type) changes nothing.
// ------------------------------------------------------------

const tChannel = getT('Automations.channelSection');
const tChannelNames = getT('Channels.names');

const unavailable = (path: string, channel: Channel): ValidationIssue => ({
  path,
  message: tChannel('unavailableOnChannel', { channel: tChannelNames(channel) }),
});

const KNOWN_TRIGGERS: ReadonlySet<string> = new Set(AUTOMATION_TRIGGERS_BY_CHANNEL.whatsapp);
const KNOWN_STEPS: ReadonlySet<string> = new Set(AUTOMATION_STEPS_BY_CHANNEL.whatsapp);

/** The trigger is a known type the channel does not offer. */
export function triggerPaletteIssues(triggerType: string, channel: Channel): ValidationIssue[] {
  if (!KNOWN_TRIGGERS.has(triggerType)) return [];
  return AUTOMATION_TRIGGERS_BY_CHANNEL[channel].includes(triggerType as AutomationTriggerType)
    ? []
    : [unavailable('trigger.type', channel)];
}

/**
 * Steps (branches included) of a known type the channel does not offer. With
 * `payloads` (activation), an Instagram reply-button step must also stay
 * buttons (not a list) and fit Instagram's quick replies, which is how it is
 * sent there; a draft may still be incomplete.
 */
export function stepPaletteIssues(steps: StepLike[], channel: Channel, payloads = true): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visit = (list: StepLike[] | undefined, prefix: string) => {
    (Array.isArray(list) ? list : []).forEach((step, i) => {
      const path = `${prefix}steps[${i}]`;
      const type = step?.step_type;
      if (KNOWN_STEPS.has(type) && !AUTOMATION_STEPS_BY_CHANNEL[channel].includes(type as AutomationStepType)) {
        issues.push(unavailable(path, channel));
      } else if (payloads && channel === 'instagram' && type === 'send_buttons' && !fitsInstagramChoices(step.step_config)) {
        issues.push(unavailable(`${path}.interactive`, channel));
      }
      if (type === 'condition' && step.branches) {
        visit(step.branches.yes, `${path}.yes.`);
        visit(step.branches.no, `${path}.no.`);
      }
    });
  };
  visit(steps, '');
  return issues;
}

function fitsInstagramChoices(config: Record<string, unknown> | undefined): boolean {
  const c = config ?? {};
  if (c.kind !== undefined && c.kind !== 'buttons') return false;
  const buttons = Array.isArray(c.buttons) ? (c.buttons as { id?: unknown; title?: unknown }[]) : [];
  return quickRepliesFit(buttons.map((b) => ({
    title: typeof b?.title === 'string' ? b.title : '',
    payload: typeof b?.id === 'string' ? b.id : '',
  })));
}

/**
 * Trigger and step types outside the channel's palette. Checked on every save,
 * draft or active: the builder offers only the palette, so this refuses only a
 * crafted request (and never a WhatsApp automation, whose palette is every type).
 */
export function channelPaletteIssues(channel: Channel, triggerType: unknown, steps: unknown): ValidationIssue[] {
  return [
    ...(typeof triggerType === 'string' ? triggerPaletteIssues(triggerType, channel) : []),
    ...stepPaletteIssues(Array.isArray(steps) ? (steps as StepLike[]) : [], channel, false),
  ];
}

/**
 * The channel a create request names: absent means WhatsApp (API-key and
 * mcp-server clients made before Stage 1); anything else must be a channel.
 */
export function parseAutomationChannel(value: unknown): Channel | null {
  if (value === undefined || value === null) return 'whatsapp';
  return isChannel(value) ? value : null;
}

/** A stored row's channel; a row read without the column is WhatsApp. */
export function automationChannel(row: { channel?: unknown } | null | undefined): Channel {
  return row?.channel === 'instagram' ? 'instagram' : 'whatsapp';
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

// ------------------------------------------------------------
// notify_team: an in-app notice to the team, never message content.
// ------------------------------------------------------------

export const NOTIFY_TEXT_MAX = 200;
/** The only placeholders a team notice may use. */
export const NOTIFY_PLACEHOLDERS: ReadonlySet<string> = new Set(['contact.name', 'automation.name']);

function notifyTextPlaceholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
}

// ------------------------------------------------------------
// send_webhook: headers and body the engine can send safely.
// ------------------------------------------------------------

/** Headers the transport owns, or that would carry ambient credentials. */
export const WEBHOOK_DENIED_HEADERS: ReadonlySet<string> = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'cookie',
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BODY_PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Why a header cannot be sent, or null. `value` is checked after placeholders are filled. */
export function webhookHeaderProblem(name: string, value: string): 'name' | 'denied' | 'value' | null {
  if (!HEADER_NAME.test(name)) return 'name';
  if (WEBHOOK_DENIED_HEADERS.has(name.toLowerCase())) return 'denied';
  if (/[\r\n\0]/.test(value)) return 'value';
  return null;
}

function webhookConfigIssues(c: Record<string, unknown>, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // The URL is sent as written: a workspace placeholder there would leak into logs, and a secret must never go there.
  if (/\{\{\s*workspace\./.test(String(c.url))) {
    issues.push({ path: `${path}.url`, message: t('webhookUrlNoWorkspace') });
  }
  if (c.headers !== undefined && c.headers !== null) {
    if (typeof c.headers !== 'object' || Array.isArray(c.headers)) {
      issues.push({ path: `${path}.headers`, message: t('webhookHeaderInvalid') });
    } else {
      for (const [name, value] of Object.entries(c.headers as Record<string, unknown>)) {
        if (typeof value !== 'string' || webhookHeaderProblem(name, value)) {
          issues.push({ path: `${path}.headers`, message: t('webhookHeaderInvalid') });
          break;
        }
      }
    }
  }
  // Placeholders are filled JSON-escaped, so they belong inside string literals; the result must still be JSON.
  if (nonEmpty(c.body_template)) {
    try {
      JSON.parse(String(c.body_template).replace(BODY_PLACEHOLDER, ''));
    } catch {
      issues.push({ path: `${path}.body_template`, message: t('webhookBodyInvalid') });
    }
  }
  return issues;
}

interface TreeStep {
  step_type: string;
  step_config?: Record<string, unknown> | null;
  branches?: { yes?: TreeStep[]; no?: TreeStep[] };
}

/** Every step in a builder tree, branches included (legacy flat seeds are already flat). */
export function allSteps<S extends TreeStep>(steps: readonly S[] | null | undefined): S[] {
  return (steps ?? []).flatMap((s) => [
    s,
    ...allSteps((s.branches?.yes ?? []) as S[]),
    ...allSteps((s.branches?.no ?? []) as S[]),
  ]);
}

/** Whether a send_webhook step's headers or body (where secrets resolve) name one of `secretKeys`. */
export function automationUsesSecrets(steps: readonly TreeStep[], secretKeys: ReadonlySet<string>): boolean {
  return allSteps(steps).some((s) => webhookStepUsesSecrets(s, secretKeys));
}

export function webhookStepUsesSecrets(step: TreeStep, secretKeys: ReadonlySet<string>): boolean {
  if (step.step_type !== 'send_webhook' || !secretKeys.size) return false;
  const text = JSON.stringify([step.step_config?.headers ?? {}, step.step_config?.body_template ?? '']);
  for (const match of text.matchAll(/\{\{\s*workspace\.([a-z][a-z0-9_]*)\s*\}\}/g)) {
    if (secretKeys.has(match[1])) return true;
  }
  return false;
}

// ------------------------------------------------------------
// Loop prevention.
//
// The only automatic edge between automations is add_tag(t) → every
// automation triggered by tag_added on t (engine.ts runStep 'add_tag').
// Not edges:
//   - assign_conversation only updates the conversation row; it never
//     dispatches conversation_assigned, so it cannot start another run.
//   - send_buttons / send_list → interactive_reply needs a customer tap.
// This is conservative: tag_added fires only for a newly added tag, so a
// cycle without a remove_tag re-arming it settles by itself. It still
// cannot be published. MAX_TAG_CHAIN_DEPTH stays as the runtime backstop.
// ------------------------------------------------------------

export interface LoopCandidate {
  /** Absent for a new automation. */
  id?: string;
  name: string;
  trigger_type: string;
  trigger_config: unknown;
  steps: readonly TreeStep[];
}

function addedTags(steps: readonly TreeStep[]): Set<string> {
  return new Set(
    allSteps(steps)
      .filter((s) => s.step_type === 'add_tag' && nonEmpty(s.step_config?.tag_id))
      .map((s) => String(s.step_config!.tag_id))
  );
}

function triggerTag(a: LoopCandidate): string | null {
  const tag = (a.trigger_config as { tag_id?: unknown } | null)?.tag_id;
  return a.trigger_type === 'tag_added' && nonEmpty(tag) ? String(tag) : null;
}

/**
 * The names along a tag_added cycle that runs through `candidate`, starting
 * and ending with it, or null when there is none. `others` are the other
 * active automations of the workspace (the candidate is skipped by id).
 */
export function findAutomationCycles(candidate: LoopCandidate, others: readonly LoopCandidate[]): string[] | null {
  const nodes = [candidate, ...others.filter((o) => !candidate.id || o.id !== candidate.id)];
  const adds = nodes.map((n) => addedTags(n.steps));
  const tags = nodes.map(triggerTag);
  const next = (i: number) => nodes.flatMap((_, j) => (tags[j] && adds[i].has(tags[j]!) ? [j] : []));
  // Depth-first from the candidate; reaching it again is a cycle through it.
  const seen = new Set<number>();
  const path: number[] = [0];
  const visit = (i: number): boolean => {
    for (const j of next(i)) {
      if (j === 0) return true;
      if (seen.has(j)) continue;
      seen.add(j);
      path.push(j);
      if (visit(j)) return true;
      path.pop();
    }
    return false;
  };
  return visit(0) ? [...path, 0].map((i) => nodes[i].name) : null;
}
