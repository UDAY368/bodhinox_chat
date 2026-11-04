import { describe, expect, it } from 'vitest';

import {
  ALL_CAPABILITIES, IMPLEMENTED_NODE_TYPES, NODE_CAPABILITIES, NODE_REGISTRY, isImplementedNodeType, nodeCapability,
  nodeCapabilityBlock, type WorkspaceCapabilities,
} from './node-registry';

const none = Object.fromEntries(NODE_CAPABILITIES.map((c) => [c, false])) as WorkspaceCapabilities;

describe('node registry', () => {
  it('registers every implemented node type with a category', () => {
    expect(IMPLEMENTED_NODE_TYPES).toContain('send_message');
    expect(IMPLEMENTED_NODE_TYPES).toContain('connect_flow');
    for (const type of IMPLEMENTED_NODE_TYPES) expect(['messaging', 'logic', 'flow']).toContain(NODE_REGISTRY[type].category);
    expect(isImplementedNodeType('send_message')).toBe(true);
    expect(isImplementedNodeType('teleport')).toBe(false);
    expect(isImplementedNodeType('__proto__')).toBe(false);
  });

  it('maps provider-gated nodes to their capability', () => {
    expect(nodeCapability('payment_link')).toBe('payments');
    expect(nodeCapability('book_appointment')).toBe('appointments');
    expect(nodeCapability('ai_reply')).toBe('ai');
    expect(nodeCapability('conversion_event')).toBe('capi');
    expect(nodeCapability('send_storefront_link')).toBe('commerce');
    expect(nodeCapability('send_message')).toBeNull();
    expect(nodeCapability('unknown_type')).toBeNull();
  });

  it('blocks a gated node only while its capability is missing', () => {
    expect(nodeCapabilityBlock('payment_link', none)).toBe('payments');
    expect(nodeCapabilityBlock('payment_link', { ...none, payments: true })).toBeNull();
    expect(nodeCapabilityBlock('book_appointment', {})).toBe('appointments');
    expect(nodeCapabilityBlock('send_message', none)).toBeNull();
    for (const type of IMPLEMENTED_NODE_TYPES) expect(nodeCapabilityBlock(type, ALL_CAPABILITIES)).toBeNull();
  });
});
