// The implemented flow node types, their palette category and the workspace
// capability a node needs before a flow using it can be published (Phase 12,
// design §6.2, AUT-05 "capability block"). Pure and client-safe: the palette
// imports it. The workspace's capabilities are loaded server-side by
// loadWorkspaceCapabilities (src/lib/flows/capabilities.ts).
//
// Only nodes the engine implements are registered; the full master-prompt
// catalogue is deferred (design §9).
import type { FlowNodeType } from './types';

export const NODE_CAPABILITIES = ['payments', 'appointments', 'ai', 'capi', 'commerce', 'meetings', 'shipping'] as const;
export type NodeCapability = (typeof NODE_CAPABILITIES)[number];
/** Which provider-gated capabilities a workspace has configured. */
export type WorkspaceCapabilities = Record<NodeCapability, boolean>;

export type NodeCategory = 'messaging' | 'logic' | 'flow';

export interface NodeRegistration {
  category: NodeCategory;
  /** A configured workspace capability the node needs; absent means always available. */
  capability?: NodeCapability;
}

export const NODE_REGISTRY = {
  start: { category: 'flow' },
  send_message: { category: 'messaging' },
  send_buttons: { category: 'messaging' },
  send_list: { category: 'messaging' },
  send_media: { category: 'messaging' },
  collect_input: { category: 'logic' },
  ask_media: { category: 'logic' },
  ask_location: { category: 'logic' },
  ask_address: { category: 'logic' },
  send_form: { category: 'messaging' },
  // A Razorpay payment link needs the workspace's connected gateway.
  payment_link: { category: 'messaging', capability: 'payments' },
  // Booking needs at least one bookable (unarchived) appointment service.
  book_appointment: { category: 'messaging', capability: 'appointments' },
  // An AI reply needs an active AI configuration.
  ai_reply: { category: 'messaging', capability: 'ai' },
  // A storefront link is refused while checkout is disabled.
  send_storefront_link: { category: 'messaging', capability: 'commerce' },
  // Conversion events are sent only through a configured Conversions API dataset.
  conversion_event: { category: 'logic', capability: 'capi' },
  // WhatsApp catalogue messages use the Meta catalogue on the number, not the
  // in-app store, so they are not gated here.
  send_product: { category: 'messaging' },
  send_product_list: { category: 'messaging' },
  send_catalog: { category: 'messaging' },
  condition: { category: 'logic' },
  set_tag: { category: 'logic' },
  set_attribute: { category: 'logic' },
  send_template: { category: 'messaging' },
  api_request: { category: 'logic' },
  // Instagram-only steps (Stage 2); channel palettes keep them off WhatsApp.
  ig_comment_reply: { category: 'messaging' },
  ig_private_reply: { category: 'messaging' },
  send_card: { category: 'messaging' },
  send_gallery: { category: 'messaging' },
  assign_agent: { category: 'flow' },
  connect_flow: { category: 'flow' },
  handoff: { category: 'flow' },
  end: { category: 'flow' },
} as const satisfies Record<FlowNodeType, NodeRegistration>;

export const IMPLEMENTED_NODE_TYPES = Object.keys(NODE_REGISTRY) as FlowNodeType[];

export function isImplementedNodeType(type: unknown): type is FlowNodeType {
  return typeof type === 'string' && Object.hasOwn(NODE_REGISTRY, type);
}

/** The capability a node type needs, or null (unknown types need none here; validation rejects them). */
export function nodeCapability(type: string): NodeCapability | null {
  if (!isImplementedNodeType(type)) return null;
  const entry: NodeRegistration = NODE_REGISTRY[type];
  return entry.capability ?? null;
}

/** The missing capability that blocks publishing a node of this type, or null when it may be published. */
export function nodeCapabilityBlock(type: string, caps: Partial<WorkspaceCapabilities>): NodeCapability | null {
  const capability = nodeCapability(type);
  return capability && caps[capability] !== true ? capability : null;
}

/** Every capability present (tests, and callers that must not block). */
export const ALL_CAPABILITIES: WorkspaceCapabilities = Object.fromEntries(
  NODE_CAPABILITIES.map((c) => [c, true]),
) as WorkspaceCapabilities;
