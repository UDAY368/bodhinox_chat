// Flow dry run (Phase 12, design §3.1): walk a flow's draft or a published
// version for a sample contact and report what WOULD happen, with no customer
// side effect at all.
//
// Why nothing can be sent, saved, queued or fetched:
//  1. This module only reads (one tenant transaction) and then calls the pure
//     simulator in preview.ts and the pure validator in validate.ts.
//  2. ESLint (eslint.config.mjs) bans importing the engine, jobs, WhatsApp,
//     Instagram, payments, appointments, webhooks, Meta Ads, notifications,
//     the automations engine and tag events here.
//  3. runDryRun wraps everything in withDryRun: every withTenant transaction
//     on any client is READ ONLY, and enqueueJob, dispatchOnce and safeFetch
//     throw before doing anything (src/lib/runtime/dry-run-guard.ts).
//  4. dry-run.integration.test.ts proves it on PostgreSQL.
//
// The response carries the trace the customer would see (placeholders filled
// with non-secret workspace values; a secret shows as "[secret]"), "would…"
// notes with parameters (never secrets: an API call shows its method and host
// only), and the validation issues that would block publishing. The sample
// contact's number is masked for a masked member. The audit row is written
// by the route, after the dry run, in a normal transaction.
import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { withDryRun } from '@/lib/runtime/dry-run-guard';
import { loadPhoneMask, maskContactRow } from '@/lib/inbox/masking-apply';
import { fillPlaceholders } from './placeholders';
import type { BuilderNode } from '@/components/flows/shared';
import { loadWorkspaceCapabilities } from './capabilities';
import { clockTimezone, conditionRules, ruleHolds } from './conditions';
import type { WorkspaceCapabilities } from './node-registry';
import { choose, startPreview, type PreviewMessage, type PreviewOptions, type PreviewWaiting } from './preview';
import type { ConditionNodeConfig, ConditionRule, FlowChannelScope, FlowRow } from './types';
import { validateFlowForActivation, type ValidationIssue } from './validate';
import { isUuid, readVersion } from './versions';

export const DRY_RUN_MAX_INPUTS = 50;
export const DRY_RUN_MAX_TEXT = 1000;
const NODE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const OPTION_ID = /^[\w:.-]{1,256}$/;

export type DryRunSource = 'draft' | 'published' | { versionId: string };

export interface DryRunInput {
  /** One of waiting.options / waiting.simulate ids, or "text" (with `text`). */
  option_id?: string;
  text?: string;
}

export interface DryRunRequest {
  source: DryRunSource;
  contactId?: string;
  inputs: DryRunInput[];
  /** api_request node_key → the port the dry run takes ("route:<i>" or "fallback"). */
  apiPorts: Record<string, string>;
}

/** Parses the POST body; null when it is not a valid dry-run request. */
export function parseDryRunRequest(body: unknown): DryRunRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  let source: DryRunSource;
  if (raw.source === undefined || raw.source === 'draft') source = 'draft';
  else if (raw.source === 'published') source = 'published';
  else if (isUuid(raw.source)) source = { versionId: raw.source };
  else return null;

  let contactId: string | undefined;
  if (raw.contact_id !== undefined && raw.contact_id !== null) {
    if (!isUuid(raw.contact_id)) return null;
    contactId = raw.contact_id;
  }

  const rawInputs = raw.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.length > DRY_RUN_MAX_INPUTS) return null;
  const inputs: DryRunInput[] = [];
  for (const item of rawInputs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { option_id: optionId, text } = item as Record<string, unknown>;
    if (optionId !== undefined && (typeof optionId !== 'string' || !OPTION_ID.test(optionId))) return null;
    if (text !== undefined && (typeof text !== 'string' || text.length > DRY_RUN_MAX_TEXT)) return null;
    if (optionId === undefined && text === undefined) return null;
    inputs.push({ ...(optionId !== undefined ? { option_id: optionId } : {}), ...(text !== undefined ? { text } : {}) });
  }

  const apiPorts: Record<string, string> = {};
  if (raw.api_ports !== undefined && raw.api_ports !== null) {
    if (typeof raw.api_ports !== 'object' || Array.isArray(raw.api_ports)) return null;
    const entries = Object.entries(raw.api_ports as Record<string, unknown>);
    if (entries.length > 100) return null;
    for (const [key, port] of entries) {
      if (!NODE_KEY.test(key) || typeof port !== 'string' || !/^(route:\d{1,3}|fallback)$/.test(port)) return null;
      apiPorts[key] = port;
    }
  }
  return { source, contactId, inputs, apiPorts };
}

// ============================================================
// Pure simulation
// ============================================================

export interface DryRunGraph {
  flow: {
    id: string;
    name: string;
    trigger_type: FlowRow['trigger_type'];
    trigger_config: Record<string, unknown>;
    /** Stage 5: further triggers (checked by the validator; the walk starts at the entry either way). */
    extra_triggers?: unknown;
    entry_node_id: string | null;
    fallback_policy: unknown;
    channel_scope: FlowChannelScope;
  };
  nodes: BuilderNode[];
  /** The version number walked; null for the draft. */
  version: number | null;
}

export interface DryRunContact {
  id: string;
  name: string | null;
  /** Masked for a masked member. */
  phone: string | null;
  email: string | null;
  company: string | null;
  /** Whether `phone` is masked (a condition on the number then waits for the author). */
  masked: boolean;
  tagIds: ReadonlySet<string>;
  /** custom_field_id → value. */
  fields: ReadonlyMap<string, string>;
}

export interface DryRunWorkspace {
  /** Non-secret {{workspace.key}} values. */
  values: Record<string, string>;
  /** Keys of secret attributes; their placeholders render as "[secret]". */
  secretKeys: ReadonlySet<string>;
}

export type WouldCode =
  | 'would_send_message'
  | 'would_send_template'
  | 'would_call_api'
  | 'would_create_payment_link'
  | 'would_book'
  | 'would_tag'
  | 'would_set_attribute'
  | 'would_assign'
  | 'would_send_conversion'
  | 'would_handoff'
  | 'would_connect_flow'
  | 'would_reply_with_ai'
  | 'would_send_storefront_link';

export interface WouldNote {
  code: WouldCode;
  node_key: string;
  /** The trace message this note belongs to. */
  message_id: number;
  params: Record<string, string>;
}

export interface DryRunResult {
  trace: PreviewMessage[];
  waiting: (PreviewWaiting & { node_key: string | null }) | null;
  ended: boolean;
  /** How many inputs were applied; an input that did not fit the wait stops the walk there. */
  applied: number;
  rejected_input: number | null;
  notes: WouldNote[];
  issues: ValidationIssue[];
  version: number | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

export const SECRET_PLACEHOLDER = '[secret]';

/**
 * Fills text the way the engine does (workspace values first, then captured
 * {{vars.*}}, which are customer input and never expand placeholders), except
 * that a secret attribute shows "[secret]" instead of its (never resolved) value.
 */
export function dryRunInterpolate(text: string, vars: Readonly<Record<string, string>>, workspace: DryRunWorkspace,
  /** Stage 5: the sample contact, for {{contact.*}} and {{custom.<id>}} (masked as shown to the member). */
  contact: DryRunContact | null = null): string {
  const withSecrets = text.replace(/\{\{\s*workspace\.([a-z][a-z0-9_]*)\s*\}\}/g, (match, key: string) =>
    (workspace.secretKeys.has(key) ? SECRET_PLACEHOLDER : match));
  // The engine's one-pass fill (placeholders.ts): captured values never expand placeholders.
  return fillPlaceholders(withSecrets, vars, workspace.values, contact ? {
    fields: { name: contact.name, email: contact.email, phone: contact.phone, company: contact.company },
    custom: Object.fromEntries(contact.fields),
  } : {});
}

const CONTACT_FIELDS = new Set(['name', 'email', 'phone', 'company']);

/**
 * A condition's result for the sample contact, as engine.ts
 * evaluateConditionNode computes it; undefined when a rule needs something
 * the dry run does not have (a contact, or the number of a masked contact).
 */
export function dryRunCondition(node: BuilderNode, vars: Readonly<Record<string, string>>,
  contact: DryRunContact | null, now: Date = new Date()): boolean | undefined {
  const cfg = node.config as unknown as ConditionNodeConfig;
  const clock = { now, timezone: clockTimezone(cfg) };
  const subjectOf = (rule: ConditionRule): { known: boolean; value?: string } => {
    switch (rule.subject) {
      case 'time':
      case 'date':
        return { known: true };
      case 'var':
        return { known: true, value: Object.hasOwn(vars, rule.subject_key) ? vars[rule.subject_key] : undefined };
      case 'tag':
        if (!contact) return { known: false };
        return { known: true, value: contact.tagIds.has(rule.subject_key) ? rule.subject_key : undefined };
      case 'custom_field': {
        if (!contact) return { known: false };
        const value = contact.fields.get(rule.subject_key);
        return { known: true, value: value ? value : undefined };
      }
      default: {
        if (!contact || !CONTACT_FIELDS.has(rule.subject_key)) return { known: false };
        if (rule.subject_key === 'phone' && contact.masked) return { known: false };
        const value = contact[rule.subject_key as 'name' | 'email' | 'phone' | 'company'];
        return { known: true, value: value ? value : undefined };
      }
    }
  };
  for (const rule of conditionRules(cfg)) {
    const subject = subjectOf(rule);
    if (!subject.known) return undefined;
    const holds = ruleHolds(rule, subject.value, clock);
    if (cfg.match === 'any' ? holds : !holds) return holds;
  }
  return cfg.match !== 'any';
}

const cfgStr = (cfg: Record<string, unknown>, key: string): string => (typeof cfg[key] === 'string' ? (cfg[key] as string) : '');

/** The host an api_request would call; never the path, query or credentials. */
export function apiHost(url: string): string {
  const trimmed = url.trim();
  // A placeholder in the scheme or host is resolved only at run time.
  const authority = /^https?:\/\/([^/?#]*)/i.exec(trimmed)?.[1] ?? '';
  if (!authority || authority.includes('{{')) return '';
  try {
    return new URL(trimmed.replace(/\{\{[^}]*\}\}/g, 'x')).host;
  } catch {
    return '';
  }
}

/** The "would…" notes for a trace: one per side effect, in order, with non-secret parameters. */
export function wouldNotes(trace: PreviewMessage[], nodes: BuilderNode[]): WouldNote[] {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const notes: WouldNote[] = [];
  const add = (m: PreviewMessage, code: WouldCode, params: Record<string, string> = {}) =>
    notes.push({ code, node_key: m.nodeKey!, message_id: m.id, params });
  for (const m of trace) {
    if (!m.nodeKey) continue;
    const node = byKey.get(m.nodeKey);
    if (!node) continue;
    const cfg = node.config;
    if (m.from === 'bot') {
      if (node.node_type === 'send_template') add(m, 'would_send_template', { template: cfgStr(cfg, 'template_name') });
      else if (node.node_type === 'payment_link') add(m, 'would_create_payment_link', { amount: String(cfg.amount ?? ''), currency: cfgStr(cfg, 'currency') });
      else if (node.node_type === 'send_storefront_link') add(m, 'would_send_storefront_link');
      else add(m, 'would_send_message', { node_type: node.node_type });
      continue;
    }
    if (m.from !== 'system') continue;
    switch (m.note) {
      case 'api_request':
        add(m, 'would_call_api', { method: cfgStr(cfg, 'method') || 'GET', host: apiHost(cfgStr(cfg, 'url')) });
        break;
      case 'book_appointment':
        add(m, 'would_book');
        break;
      case 'set_tag':
        add(m, 'would_tag', { mode: cfgStr(cfg, 'mode') || 'add' });
        break;
      case 'set_attribute':
        add(m, 'would_set_attribute', { target: cfgStr(cfg, 'target'), key: cfgStr(cfg, 'key') });
        break;
      case 'assign_agent':
        add(m, 'would_assign', { mode: cfgStr(cfg, 'mode') });
        break;
      case 'conversion_event':
        add(m, 'would_send_conversion', { event: cfgStr(cfg, 'event_name') });
        break;
      case 'ai_reply':
        add(m, 'would_reply_with_ai');
        break;
      case 'handoff':
        add(m, 'would_handoff');
        break;
      case 'connect_flow':
        add(m, 'would_connect_flow', { flow_id: cfgStr(cfg, 'flow_id') });
        break;
    }
  }
  return notes;
}

export interface SimulateContext {
  workspace: DryRunWorkspace;
  contact: DryRunContact | null;
  caps: Partial<WorkspaceCapabilities>;
  now?: Date;
}

/** Walks the graph through the inputs. Pure: no I/O. */
export function simulateDryRun(graph: DryRunGraph, request: Pick<DryRunRequest, 'inputs' | 'apiPorts'>, ctx: SimulateContext): DryRunResult {
  const options: PreviewOptions = {
    interpolate: (text, vars) => dryRunInterpolate(text, vars, ctx.workspace, ctx.contact),
    apiPort: (nodeKey) => (Object.hasOwn(request.apiPorts, nodeKey) ? request.apiPorts[nodeKey] : undefined),
    condition: (node, vars) => dryRunCondition(node, vars, ctx.contact, ctx.now),
  };
  let state = startPreview(graph.nodes, graph.flow.entry_node_id, options);
  let applied = 0;
  let rejected: number | null = null;
  for (const input of request.inputs) {
    if (!state.waiting || state.ended) {
      rejected = applied;
      break;
    }
    const next = input.option_id && input.option_id !== 'text'
      ? choose(state, input.option_id)
      : choose(state, 'text', input.text ?? '');
    if (next === state) {
      rejected = applied;
      break;
    }
    state = next;
    applied += 1;
  }
  const issues = validateFlowForActivation(
    { id: graph.flow.id, name: graph.flow.name, trigger_type: graph.flow.trigger_type, trigger_config: graph.flow.trigger_config,
      extra_triggers: graph.flow.extra_triggers ?? [],
      entry_node_id: graph.flow.entry_node_id, fallback_policy: graph.flow.fallback_policy, channel_scope: graph.flow.channel_scope },
    graph.nodes,
    { caps: ctx.caps },
  );
  return {
    trace: state.messages,
    waiting: state.waiting ? { ...state.waiting, node_key: state.at } : null,
    ended: state.ended,
    applied,
    rejected_input: rejected,
    notes: wouldNotes(state.messages, graph.nodes),
    issues,
    version: graph.version,
    contact: ctx.contact ? { id: ctx.contact.id, name: ctx.contact.name, phone: ctx.contact.phone } : null,
  };
}

// ============================================================
// The read transaction
// ============================================================

/** A dry-run request that cannot be served: the flow, version or contact is missing (404) or unpublished (409). */
export class DryRunError extends Error {
  constructor(public readonly code: 'not_found' | 'not_published') {
    super(code);
    this.name = 'DryRunError';
  }
}

interface FlowDbRow {
  id: string;
  name: string;
  trigger_type: FlowRow['trigger_type'];
  trigger_config: Record<string, unknown> | null;
  extra_triggers: unknown;
  entry_node_id: string | null;
  fallback_policy: unknown;
  channel_scope: FlowChannelScope | null;
  published_version_id: string | null;
}

interface Loaded {
  graph: DryRunGraph;
  workspace: DryRunWorkspace;
  contact: DryRunContact | null;
}

async function loadDryRun(ctx: TenantContext, flowId: string, request: DryRunRequest): Promise<Loaded> {
  return withTenant(ctx, async (tx) => {
    const flows = await tx.$queryRaw<FlowDbRow[]>(Prisma.sql`SELECT id::text, name, trigger_type, trigger_config, extra_triggers, entry_node_id,
        fallback_policy, channel_scope, published_version_id::text
      FROM flows WHERE account_id=${ctx.accountId}::uuid AND id=${flowId}::uuid`);
    const flow = flows[0];
    if (!flow) throw new DryRunError('not_found');

    let graph: DryRunGraph;
    const base = { id: flow.id, name: flow.name };
    if (request.source === 'draft') {
      const nodes = await tx.$queryRaw<BuilderNode[]>(Prisma.sql`SELECT node_key, node_type, config, position_x, position_y
        FROM flow_nodes WHERE account_id=${ctx.accountId}::uuid AND flow_id=${flowId}::uuid ORDER BY node_key`);
      graph = {
        flow: { ...base, trigger_type: flow.trigger_type, trigger_config: flow.trigger_config ?? {}, extra_triggers: flow.extra_triggers ?? [],
          entry_node_id: flow.entry_node_id,
          fallback_policy: flow.fallback_policy, channel_scope: flow.channel_scope ?? 'whatsapp' },
        nodes,
        version: null,
      };
    } else {
      const versionId = request.source === 'published' ? flow.published_version_id : request.source.versionId;
      if (!versionId) throw new DryRunError('not_published');
      const version = await readVersion(tx, ctx.accountId, versionId);
      // A version of another flow is as missing as one of another workspace.
      if (!version || version.flow_id !== flow.id) throw new DryRunError('not_found');
      graph = {
        flow: { ...base, trigger_type: version.trigger_type, trigger_config: version.trigger_config ?? {}, extra_triggers: version.extra_triggers ?? [],
          entry_node_id: version.entry_node_id,
          fallback_policy: version.fallback_policy, channel_scope: version.channel_scope },
        nodes: version.nodes as BuilderNode[],
        version: version.version,
      };
    }

    const attributes = await tx.$queryRaw<{ key: string; value: string | null; is_secret: boolean }[]>(Prisma.sql`
      SELECT key, CASE WHEN is_secret THEN NULL ELSE value END AS value, is_secret
      FROM workspace_attributes WHERE account_id=${ctx.accountId}::uuid`);
    const workspace: DryRunWorkspace = { values: {}, secretKeys: new Set() };
    for (const a of attributes) {
      if (a.is_secret) (workspace.secretKeys as Set<string>).add(a.key);
      else if (a.value !== null) workspace.values[a.key] = a.value;
    }

    let contact: DryRunContact | null = null;
    if (request.contactId) {
      const rows = await tx.$queryRaw<{ id: string; name: string | null; phone: string | null; email: string | null; company: string | null }[]>(
        Prisma.sql`SELECT id::text, name, phone, email, company FROM contacts
          WHERE account_id=${ctx.accountId}::uuid AND id=${request.contactId}::uuid`);
      if (!rows[0]) throw new DryRunError('not_found');
      const masked = await loadPhoneMask(tx, ctx);
      const row = maskContactRow(rows[0], masked);
      const tags = await tx.$queryRaw<{ tag_id: string }[]>(Prisma.sql`SELECT tag_id::text FROM contact_tags
        WHERE account_id=${ctx.accountId}::uuid AND contact_id=${request.contactId}::uuid`);
      const fields = await tx.$queryRaw<{ custom_field_id: string; value: string | null }[]>(Prisma.sql`SELECT custom_field_id::text, value
        FROM contact_custom_values WHERE account_id=${ctx.accountId}::uuid AND contact_id=${request.contactId}::uuid`);
      contact = {
        ...row,
        masked,
        tagIds: new Set(tags.map((t) => t.tag_id)),
        fields: new Map(fields.filter((f) => f.value).map((f) => [f.custom_field_id, f.value as string])),
      };
    }
    return { graph, workspace, contact };
  });
}

/**
 * Runs a dry run for a member. Everything runs inside withDryRun, so even a
 * mistake in a module this one calls cannot write, queue, send or fetch.
 */
export async function runDryRun(ctx: TenantContext, flowId: string, request: DryRunRequest): Promise<DryRunResult> {
  if (!isUuid(flowId)) throw new DryRunError('not_found');
  return withDryRun(async () => {
    const loaded = await loadDryRun(ctx, flowId, request);
    const caps = await loadWorkspaceCapabilities(ctx);
    return simulateDryRun(loaded.graph, request, { workspace: loaded.workspace, contact: loaded.contact, caps });
  });
}
