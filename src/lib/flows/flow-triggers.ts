// Stage 5: the triggers a flow listens on. Pure and client-safe.
//
// A flow has one primary trigger (flows.trigger_type / trigger_config) and, on
// Instagram, up to FLOW_TRIGGER_LIMITS.extraTriggers more in
// flows.extra_triggers (COMBINABLE_TRIGGERS only). The engine (5B), the
// builder's trigger stack (5C) and the automation list (5F) all read the list
// through effectiveTriggers so the primary always comes first and a malformed
// stored entry is skipped instead of breaking a caller.
import { FLOW_TRIGGER_TYPES, type FlowTriggerConfig, type FlowTriggerType } from './types';

/** The fields of a flow (or a flow_versions snapshot) that carry its triggers. */
export interface FlowTriggerSource {
  trigger_type: FlowTriggerType | string;
  trigger_config: unknown;
  extra_triggers?: unknown;
}

const isTriggerType = (value: unknown): value is FlowTriggerType =>
  typeof value === 'string' && (FLOW_TRIGGER_TYPES as readonly string[]).includes(value);

const configOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The primary trigger first, then each well-formed `extra_triggers` entry in
 * stored order. An entry with an unknown type, or one that repeats the
 * primary's type with the same config, is skipped. A flow without extra
 * triggers (every flow before Stage 5) yields exactly its primary trigger.
 */
export function effectiveTriggers(flow: FlowTriggerSource): FlowTriggerConfig[] {
  const out: FlowTriggerConfig[] = [];
  if (isTriggerType(flow.trigger_type)) {
    out.push({ trigger_type: flow.trigger_type, config: configOf(flow.trigger_config) } as FlowTriggerConfig);
  }
  const extras = Array.isArray(flow.extra_triggers) ? flow.extra_triggers : [];
  const seen = new Set(out.map((t) => `${t.trigger_type}:${JSON.stringify(t.config)}`));
  for (const entry of extras) {
    const item = configOf(entry);
    if (!isTriggerType(item.trigger_type)) continue;
    const trigger = { trigger_type: item.trigger_type, config: configOf(item.config) } as FlowTriggerConfig;
    const key = `${trigger.trigger_type}:${JSON.stringify(trigger.config)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trigger);
  }
  return out;
}

/** The distinct trigger types a flow listens on, primary first. */
export function effectiveTriggerTypes(flow: FlowTriggerSource): FlowTriggerType[] {
  return [...new Set(effectiveTriggers(flow).map((t) => t.trigger_type))];
}
