/**
 * Which condition subjects the Condition step offers per channel, how the
 * picker groups them, and which operators each allows (Stage 5). Pure, so
 * the form and its tests share it; the publish validator (5B) checks the
 * same rules on the server.
 *
 * WhatsApp flows keep exactly the subjects they had; the Stage 5 subjects
 * (Instagram profile, system fields, segment, link clicked, workspace field,
 * sequence) are offered on Instagram flows.
 */

import { IG_PROFILE_FACTS, SYSTEM_FACTS, type ConditionOperator, type ConditionSubject, type FlowChannelScope } from "@/lib/flows/types";

/** Subjects every flow offered before Stage 5, in picker order. */
export const BASE_SUBJECTS: ConditionSubject[] = ["var", "tag", "contact_field", "custom_field", "time", "date"];
/** Subjects added on Instagram flows (Stage 5). */
export const INSTAGRAM_SUBJECTS: ConditionSubject[] = ["ig_profile", "system", "segment", "link_click", "workspace_field", "sequence"];

export type SubjectGroup = "recommended" | "general" | "system";

export function conditionSubjectsFor(scope: FlowChannelScope | null | undefined): ConditionSubject[] {
  return scope === "instagram" ? [...BASE_SUBJECTS, ...INSTAGRAM_SUBJECTS] : [...BASE_SUBJECTS];
}

/** The picker's groups: Recommended, General filters, System fields. */
export function subjectGroup(subject: ConditionSubject): SubjectGroup {
  switch (subject) {
    case "tag":
    case "contact_field":
    case "ig_profile":
      return "recommended";
    case "system":
    case "workspace_field":
    case "var":
      return "system";
    default:
      return "general";
  }
}

export function groupSubjects(subjects: readonly ConditionSubject[]): Array<{ group: SubjectGroup; subjects: ConditionSubject[] }> {
  return (["recommended", "general", "system"] as const)
    .map((group) => ({ group, subjects: subjects.filter((s) => subjectGroup(s) === group) }))
    .filter((g) => g.subjects.length > 0);
}

const ALL: ConditionOperator[] = ["present", "absent", "equals", "not_equals", "contains", "gt", "gte", "lt", "lte", "between"];
const CLOCK: ConditionOperator[] = ["equals", "not_equals", "gt", "gte", "lt", "lte", "between"];
const NUMERIC: ConditionOperator[] = ["equals", "not_equals", "gt", "gte", "lt", "lte"];
const TEXT: ConditionOperator[] = ["present", "absent", "equals", "not_equals", "contains"];
const MOMENT: ConditionOperator[] = ["present", "absent", "gt", "lt"];

/** A subject whose rule is a yes/no choice (`equals` "true" / "false"). */
export function isYesNoSubject(subject: ConditionSubject, key: string): boolean {
  if (subject === "segment" || subject === "link_click" || subject === "sequence") return true;
  if (subject === "ig_profile") return key !== "follower_count";
  if (subject === "system") return key === "subscribed";
  return false;
}

/** The operators a rule on `subject` (and `key`, for facts) may use. */
export function operatorsFor(subject: ConditionSubject, key = ""): ConditionOperator[] {
  if (isYesNoSubject(subject, key)) return ["equals"];
  switch (subject) {
    case "time":
    case "date":
      return CLOCK;
    case "ig_profile":
      return NUMERIC; // follower_count
    case "system":
      if (key === "last_interaction_at" || key === "window_open_until") return MOMENT;
      if (key === "contact_id") return ["equals", "not_equals"];
      return TEXT; // ig_username
    case "workspace_field":
      return ["present", "absent", "equals", "not_equals", "contains", "gt", "gte", "lt", "lte"];
    default:
      return ALL;
  }
}

/** The keys a subject picks from when they are a fixed list. */
export function subjectKeys(subject: ConditionSubject): readonly string[] | null {
  if (subject === "ig_profile") return IG_PROFILE_FACTS;
  if (subject === "system") return SYSTEM_FACTS;
  return null;
}

/** Steps whose tracked links a "link clicked" rule can test: cards, galleries and buttons with link buttons. */
export function linkSteps<T extends { node_key: string; node_type: string; config: Record<string, unknown> }>(nodes: readonly T[]): T[] {
  return nodes.filter((n) => n.node_type === "send_card" || n.node_type === "send_gallery" ||
    (n.node_type === "send_buttons" && Array.isArray(n.config.link_buttons) && n.config.link_buttons.length > 0));
}

/**
 * The rule after picking a subject: the first fact for a fixed list, the
 * first allowed operator (a time window for `time`, `equals` for a variable),
 * and "true" for a yes/no subject.
 */
export function ruleForSubject(subject: ConditionSubject): { subject: ConditionSubject; subject_key: string; operator: ConditionOperator; value: string } {
  const keys = subjectKeys(subject);
  const key = keys ? keys[0] : "";
  const operator: ConditionOperator = subject === "time" ? "between" : subject === "var" ? "equals" : operatorsFor(subject, key)[0];
  return { subject, subject_key: key, operator, value: isYesNoSubject(subject, key) ? "true" : "" };
}
