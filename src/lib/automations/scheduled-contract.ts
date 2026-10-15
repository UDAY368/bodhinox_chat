import { CronExpressionParser } from 'cron-parser';
import type { AudienceConfig } from '@/lib/broadcast-audience';

export const MAX_SCHEDULED_CONTACTS = 1000;
export type ScheduledAudience = Omit<AudienceConfig, 'type' | 'csvContacts'> & {
  type: 'all' | 'tags' | 'custom_field';
};
export interface ScheduledStep {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: ScheduledStep[]; no?: ScheduledStep[] };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function scheduleNeedsContact(steps: readonly ScheduledStep[]): boolean {
  return steps.some(
    (step) =>
      !['wait', 'send_webhook', 'condition'].includes(step.step_type) ||
      (step.step_type === 'condition' &&
        ['tag_presence', 'contact_field'].includes(
          String(step.step_config?.subject)
        )) ||
      scheduleNeedsContact(step.branches?.yes ?? []) ||
      scheduleNeedsContact(step.branches?.no ?? [])
  );
}
export function validCronSchedule(schedule: unknown): boolean {
  if (
    typeof schedule !== 'string' ||
    schedule.length > 200 ||
    schedule.trim().split(/\s+/).length !== 5
  )
    return false;
  try {
    CronExpressionParser.parse(schedule);
    return true;
  } catch {
    return false;
  }
}
export function validScheduleTimezone(timezone: unknown): boolean {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 100)
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
/** A schedule must explicitly choose its recipients; CSV import is a broadcast operation. */
export function parseScheduledAudience(value: unknown): ScheduledAudience {
  const fail = () => {
    throw new Error(
      'Choose all contacts, at least one tenant tag, or a valid custom-field filter for this schedule'
    );
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['type', 'tagIds', 'customField', 'excludeTagIds'].includes(key)
    )
  )
    return fail();
  const ids = (entry: unknown): string[] => {
    if (
      !Array.isArray(entry) ||
      entry.length > 100 ||
      entry.some((id) => typeof id !== 'string' || !uuid.test(id))
    )
      return fail();
    return [...new Set(entry as string[])];
  };
  const excludeTagIds =
    input.excludeTagIds === undefined ? undefined : ids(input.excludeTagIds);
  if (input.type === 'all') return { type: 'all', excludeTagIds };
  if (input.type === 'tags') {
    const tagIds = ids(input.tagIds);
    if (!tagIds.length) return fail();
    return { type: 'tags', tagIds, excludeTagIds };
  }
  if (input.type === 'custom_field') {
    const field = input.customField as Record<string, unknown> | undefined;
    if (
      !field ||
      typeof field.fieldId !== 'string' ||
      !uuid.test(field.fieldId) ||
      !['is', 'is_not', 'contains'].includes(String(field.operator)) ||
      typeof field.value !== 'string' ||
      !field.value.trim() ||
      field.value.length > 1000 ||
      Object.keys(field).some(
        (key) => !['fieldId', 'operator', 'value'].includes(key)
      )
    )
      return fail();
    return {
      type: 'custom_field',
      customField: {
        fieldId: field.fieldId,
        operator: field.operator as 'is' | 'is_not' | 'contains',
        value: field.value,
      },
      excludeTagIds,
    };
  }
  return fail();
}
