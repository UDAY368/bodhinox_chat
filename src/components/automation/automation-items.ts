/**
 * The Automation list's rows: flows, rules (the automations table) and
 * Instagram sequences as one shape, so one list shows them under
 * All / Flows / Rules / Sequences. Pure: no React and no I/O.
 *
 * Status: a flow keeps its own (draft, testing, live, stopped, archived); a
 * rule is live while on, otherwise stopped once it ever ran and a draft until
 * then; a sequence is live or stopped.
 */

import type { Channel } from '@/types';
import { effectiveTriggers } from '@/lib/flows/flow-triggers';
import type { FlowChannelScope, FlowTriggerType } from '@/lib/flows/types';

export type AutomationKind = 'flow' | 'rule' | 'sequence';
export const AUTOMATION_KINDS: readonly AutomationKind[] = ['flow', 'rule', 'sequence'];
/** The list's tabs: every kind, or one. */
export type KindTab = 'all' | AutomationKind;
export const KIND_TABS: readonly KindTab[] = ['all', ...AUTOMATION_KINDS];

export type ItemStatus = 'active' | 'paused' | 'draft' | 'testing' | 'archived';
export type StatusFilter = 'all' | ItemStatus;
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'active', 'paused', 'draft', 'testing', 'archived'];

/** A flow as GET /api/flows returns it (the fields the list reads). */
export interface FlowRow {
  id: string;
  /** Who created the flow (audit identity; may have left the account). */
  user_id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  trigger_type: FlowTriggerType;
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  extra_triggers?: unknown;
  execution_count: number;
  last_executed_at: string | null;
  test_numbers?: string[];
  test_usernames?: string[];
  /** Absent on rows read before Phase 11: WhatsApp. */
  channel_scope?: FlowChannelScope;
  published_version_id?: string | null;
  folder_id?: string | null;
  /** Stage 5: whole-percent click-through rate; null when no tracked link was sent. */
  ctr?: number | null;
  created_at: string;
  updated_at: string;
}

/** A rule as GET /api/automations returns it (the fields the list reads). */
export interface RuleRow {
  id: string;
  user_id: string;
  name: string;
  description?: string | null;
  trigger_type: string;
  trigger_config?: Record<string, unknown> | null;
  /** Absent on rows from before channels: WhatsApp. */
  channel?: Channel | null;
  is_active: boolean;
  execution_count: number;
  last_executed_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** An Instagram sequence as GET /api/sequences returns it. */
export interface SequenceRow {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'archived';
  subscribers: number;
  messages: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationItem {
  /** Unique across kinds (`flow:<id>`). */
  key: string;
  kind: AutomationKind;
  id: string;
  name: string;
  description: string | null;
  /** 'any' is a legacy flow that runs on both channels. */
  channel: Channel | 'any';
  status: ItemStatus;
  runs: number;
  /** Flows only: null when no tracked link was sent. */
  ctr: number | null;
  updatedAt: string;
  creatorId: string | null;
  folderId: string | null;
  flow?: FlowRow;
  rule?: RuleRow;
  sequence?: SequenceRow;
}

/** "testing" is a draft flow with test numbers or usernames, the same split the status shows. */
export function displayStatus(flow: Pick<FlowRow, 'status' | 'test_numbers' | 'test_usernames'>): ItemStatus {
  const testers = (flow.test_numbers ?? []).length + (flow.test_usernames ?? []).length;
  return flow.status === 'draft' && testers > 0 ? 'testing' : flow.status;
}

export function flowItem(flow: FlowRow): AutomationItem {
  return {
    key: `flow:${flow.id}`, kind: 'flow', id: flow.id, name: flow.name, description: flow.description,
    channel: flow.channel_scope ?? 'whatsapp', status: displayStatus(flow), runs: flow.execution_count,
    ctr: flow.ctr ?? null, updatedAt: flow.updated_at, creatorId: flow.user_id, folderId: flow.folder_id ?? null, flow,
  };
}

export function ruleItem(rule: RuleRow): AutomationItem {
  return {
    key: `rule:${rule.id}`, kind: 'rule', id: rule.id, name: rule.name, description: rule.description ?? null,
    channel: rule.channel === 'instagram' ? 'instagram' : 'whatsapp',
    status: rule.is_active ? 'active' : rule.execution_count > 0 ? 'paused' : 'draft',
    runs: rule.execution_count, ctr: null, updatedAt: rule.updated_at, creatorId: rule.user_id, folderId: null, rule,
  };
}

export function sequenceItem(sequence: SequenceRow): AutomationItem {
  return {
    key: `sequence:${sequence.id}`, kind: 'sequence', id: sequence.id, name: sequence.name, description: null,
    channel: 'instagram', status: sequence.status === 'active' ? 'active' : sequence.status === 'archived' ? 'archived' : 'paused',
    runs: sequence.subscribers, ctr: null, updatedAt: sequence.updated_at, creatorId: null, folderId: null, sequence,
  };
}

/** Every row, newest edit first (sequences that were archived are not listed by the API). */
export function automationItems(flows: FlowRow[], rules: RuleRow[], sequences: SequenceRow[]): AutomationItem[] {
  return [...flows.map(flowItem), ...rules.map(ruleItem), ...sequences.map(sequenceItem)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
}

const words = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** Name, description and trigger words, lower-cased for the search box. */
export function searchText(item: AutomationItem): string {
  const parts = [item.name, item.description ?? ''];
  if (item.flow) {
    for (const { config } of effectiveTriggers(item.flow)) {
      const cfg = config as Record<string, unknown>;
      parts.push(...words(cfg.keywords), ...words(cfg.refs), String(cfg.template_name ?? ''));
    }
  }
  if (item.rule) parts.push(...words(item.rule.trigger_config?.keywords));
  return parts.join(' ').toLowerCase();
}

export interface ItemFilters {
  kind: KindTab;
  status: StatusFilter;
  /** Flow trigger type; a rule or sequence never has one, so it is left out while one is chosen. */
  trigger: FlowTriggerType | 'all';
  /** 'all', 'none' (top level) or a folder id; folders hold flows only. */
  folder: 'all' | 'none' | string;
  channel: Channel | 'all';
  query: string;
}

export function itemMatches(item: AutomationItem, filters: ItemFilters): boolean {
  if (filters.kind !== 'all' && item.kind !== filters.kind) return false;
  if (filters.status !== 'all' && item.status !== filters.status) return false;
  if (filters.channel !== 'all' && item.channel !== filters.channel && item.channel !== 'any') return false;
  if (filters.trigger !== 'all' && !(item.flow && effectiveTriggers(item.flow).some((t) => t.trigger_type === filters.trigger))) return false;
  if (filters.folder === 'none' && item.folderId) return false;
  if (filters.folder !== 'all' && filters.folder !== 'none' && item.folderId !== filters.folder) return false;
  const needle = filters.query.trim().toLowerCase();
  return !needle || searchText(item).includes(needle);
}

/** How many rows each tab holds (before the other filters, as the prototype counts). */
export function kindCounts(items: AutomationItem[]): Record<KindTab, number> {
  return {
    all: items.length,
    flow: items.filter((i) => i.kind === 'flow').length,
    rule: items.filter((i) => i.kind === 'rule').length,
    sequence: items.filter((i) => i.kind === 'sequence').length,
  };
}

/** Whether the row's Live switch can be used: an archived flow is restored first. */
export function canSwitch(item: AutomationItem): boolean {
  return item.status !== 'archived';
}

/**
 * A problem the list can see without opening the automation (the server checks
 * the full automation again when it goes live): a sequence with no messages
 * has nothing to send.
 */
export function listProblems(item: AutomationItem): number {
  return item.kind === 'sequence' && (item.sequence?.messages ?? 0) === 0 ? 1 : 0;
}

/** The row's status after its Live switch moved (what the server answers, when it says). */
export function statusAfterSwitch(item: AutomationItem, on: boolean, serverStatus?: string | null): ItemStatus {
  if (serverStatus === 'active' || serverStatus === 'paused' || serverStatus === 'draft' || serverStatus === 'archived') {
    return item.flow ? displayStatus({ ...item.flow, status: serverStatus }) : serverStatus;
  }
  return on ? 'active' : 'paused';
}

/** The number of problems in a refusal body ({ issues: [...] }), counting errors only when severities are given. */
export function problemCount(body: unknown): number {
  const issues = body && typeof body === 'object' && Array.isArray((body as { issues?: unknown }).issues)
    ? (body as { issues: Array<{ severity?: unknown }> }).issues : [];
  const errors = issues.filter((issue) => issue && issue.severity !== 'warning');
  return errors.length;
}
