/**
 * Routing rule shapes and limits shared by the server (src/lib/inbox/routing.ts)
 * and the settings UI. Pure: no I/O, safe to import from client components.
 */

export const MAX_ROUTING_RULES = 50;
export const MAX_RULE_NAME = 120;
export const MAX_TAG_CONDITIONS = 20;
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 60;
export const MAX_ROUND_ROBIN_MEMBERS = 50;
export const MAX_REASSIGN_MINUTES = 10080;

export interface RoutingConditions {
  /** Matches when the contact has any of these tags. */
  tags_any?: string[];
  /** Matches when the customer's message contains any of these (case-insensitive). */
  keywords_any?: string[];
  /** Matches conversations on this WhatsApp number (whatsapp_config.id). */
  whatsapp_config_id?: string;
  /** true: only inside working hours; false: only outside them. */
  within_working_hours?: boolean;
}

export type AssignTo =
  | { mode: 'member'; user_id: string }
  | { mode: 'round_robin'; user_ids: string[] };

/** The fixed projection the routes return (never the round-robin cursor). */
export interface RoutingRule {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RoutingConditions;
  assign_to: AssignTo;
  reassign_after_minutes: number | null;
  created_at: string;
  updated_at: string;
}

export interface RoutingRuleInput {
  name: string;
  enabled: boolean;
  conditions: RoutingConditions;
  assign_to: AssignTo;
  reassign_after_minutes: number | null;
}
