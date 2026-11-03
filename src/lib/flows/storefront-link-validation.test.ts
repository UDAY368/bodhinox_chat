import { describe, expect, it } from 'vitest';
import type { BuilderNode } from '@/components/flows/shared';
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from './edges';
import { storefrontLinkEdges, storefrontLinkIssues } from './storefront-link-validation';

const keys = new Set(['shop', 'thanks', 'oops']);
const good = { message: 'Browse our store', ttl_hours: 24, purpose: 'shop', next_node_key: 'thanks', failed_next: 'oops' };
const node = (config: Record<string, unknown>) => ({ node_key: 'shop', node_type: 'send_storefront_link' as const, config });
const fields = (config: Record<string, unknown>) => storefrontLinkIssues(node(config), keys).map((i) => i.field);

describe('send_storefront_link authoring', () => {
  it('accepts a complete step and an unwired failed port', () => {
    expect(fields(good)).toEqual([]);
    expect(fields({ ...good, failed_next: '', ttl_hours: undefined })).toEqual([]);
  });

  it('needs a message, a valid lifetime and purpose, and the next step', () => {
    expect(fields({ ...good, message: ' ' })).toContain('message');
    expect(fields({ ...good, message: 'x'.repeat(1025) })).toContain('message');
    expect(fields({ ...good, ttl_hours: 0 })).toContain('ttl_hours');
    expect(fields({ ...good, ttl_hours: 169 })).toContain('ttl_hours');
    expect(fields({ ...good, ttl_hours: 1.5 })).toContain('ttl_hours');
    expect(fields({ ...good, purpose: 'cart' })).toContain('purpose');
    expect(fields({ ...good, next_node_key: '' })).toContain('next_node_key');
    expect(fields({ ...good, failed_next: 'gone' })).toEqual(['failed_next']);
  });

  it('wires next and failed ports on the canvas', () => {
    expect(storefrontLinkEdges(good)).toEqual(['thanks', 'oops']);
    const nodes: BuilderNode[] = [
      { node_key: 'shop', node_type: 'send_storefront_link', config: { ...good, next_node_key: '', failed_next: '' } },
      { node_key: 'thanks', node_type: 'end', config: {} },
    ];
    expect(outgoingSlots(nodes[0]).map((s) => s.id)).toEqual(['next', 'failed']);
    expect(applyEdgeConnection(nodes[0], 'next', 'thanks')).toMatchObject({ next_node_key: 'thanks' });
    expect(applyEdgeConnection(nodes[0], 'failed', 'thanks')).toMatchObject({ failed_next: 'thanks' });
    const wired = { ...nodes[0], config: { ...good, failed_next: 'thanks' } };
    expect(deriveCanvasEdges([wired, nodes[1]]).map((e) => e.sourceHandle).sort()).toEqual(['failed', 'next']);
    const unlinked = unlinkNodeReferences([wired, nodes[1]], 'thanks');
    expect(unlinked[0].config).toMatchObject({ next_node_key: '', failed_next: '' });
  });
});
