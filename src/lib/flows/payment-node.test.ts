import { describe, expect, it } from 'vitest';
import type { BuilderNode } from '@/components/flows/shared';
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from './edges';
import { paymentPortFor } from './engine';
import { paymentLinkEdges, paymentLinkIssues } from './payment-node';
import { choose, startPreview } from './preview';
import { validateFlowForActivation } from './validate';

const keys = new Set(['pay', 'thanks', 'sorry', 'oops']);
const node = (config: Record<string, unknown>) => ({ node_key: 'pay', node_type: 'payment_link' as const, config });
const good = { amount: '499.50', currency: 'INR', message: 'Pay here', paid_next: 'thanks', expired_next: 'sorry', failed_next: 'oops' };
const fields = (config: Record<string, unknown>) => paymentLinkIssues(node(config), keys).map((i) => i.field);

describe('paymentLinkIssues', () => {
  it('accepts a complete step, and one built from variables', () => {
    expect(paymentLinkIssues(node(good), keys)).toEqual([]);
    expect(paymentLinkIssues(node({ ...good, amount: '{{vars.total}}' }), keys)).toEqual([]);
  });
  it('needs an amount, a currency and the paid port', () => {
    expect(fields({ ...good, amount: '' })).toContain('amount');
    expect(fields({ ...good, amount: '0' })).toContain('amount');
    expect(fields({ ...good, amount: '12.345' })).toContain('amount');
    expect(fields({ ...good, currency: 'rs' })).toContain('currency');
    expect(fields({ ...good, paid_next: '' })).toContain('paid_next');
  });
  it('lets the expired and failed ports stay unwired, but not point nowhere', () => {
    expect(fields({ ...good, expired_next: '', failed_next: undefined })).toEqual([]);
    expect(fields({ ...good, expired_next: 'gone' })).toEqual(['expired_next']);
  });
  it('checks expiry and text limits', () => {
    expect(fields({ ...good, expire_minutes: 5 })).toEqual(['expire_minutes']);
    expect(fields({ ...good, expire_minutes: 60 })).toEqual([]);
    expect(fields({ ...good, message: 'x'.repeat(901) })).toEqual(['message']);
    expect(fields({ ...good, description: 'x'.repeat(2049) })).toEqual(['description']);
  });
  it('lists the wired ports as edges', () => {
    expect(paymentLinkEdges({ ...good, failed_next: '' })).toEqual(['thanks', 'sorry']);
  });
});

describe('payment_link in the flow', () => {
  const builder = (config: Record<string, unknown>): BuilderNode => ({ node_key: 'pay', node_type: 'payment_link', config });
  const end = (key: string): BuilderNode => ({ node_key: key, node_type: 'end', config: {} });
  const nodes = [builder(good), end('thanks'), end('sorry'), end('oops')];

  it('draws the paid, expired and failed ports', () => {
    expect(outgoingSlots(builder(good)).map((s) => s.id)).toEqual(['paid', 'expired', 'failed']);
    expect(outgoingSlots(builder({ ...good, timeout_minutes: 60 })).map((s) => s.id)).toEqual(['paid', 'expired', 'failed', 'timeout']);
    expect(deriveCanvasEdges(nodes).map((e) => `${e.sourceHandle}->${e.target}`).sort()).toEqual(['expired->sorry', 'failed->oops', 'paid->thanks']);
  });
  it('connects and unlinks each port', () => {
    expect(applyEdgeConnection(builder(good), 'paid', 'x')).toEqual({ paid_next: 'x' });
    expect(applyEdgeConnection(builder(good), 'expired', 'x')).toEqual({ expired_next: 'x' });
    expect(applyEdgeConnection(builder(good), 'failed', 'x')).toEqual({ failed_next: 'x' });
    expect(applyEdgeConnection(builder(good), 'next', 'x')).toBeNull();
    const [after] = unlinkNodeReferences(nodes, 'sorry');
    expect(after.config).toMatchObject({ paid_next: 'thanks', expired_next: '', failed_next: 'oops' });
    expect(unlinkNodeReferences(nodes, 'thanks')[0].config.paid_next).toBe('');
  });
  it('routes each outcome to its port; an unwired one ends the run', () => {
    expect(paymentPortFor(good, 'paid')).toBe('thanks');
    expect(paymentPortFor(good, 'expired')).toBe('sorry');
    expect(paymentPortFor({ ...good, failed_next: '' }, 'failed')).toBeNull();
  });
  it('validates as a waiting step that may time out, and passes its variables on', () => {
    const flow = { name: 'Pay', trigger_type: 'manual' as const, trigger_config: {}, entry_node_id: 'pay' };
    const withTimeout = [builder({ ...good, timeout_minutes: 30, after_timeout: 'oops' }), end('thanks'), end('sorry'), end('oops')];
    expect(validateFlowForActivation(flow, withTimeout).filter((i) => i.severity === 'error')).toEqual([]);
    // A later step may use what the payment step stores without a "never set" warning.
    const usesVars = [builder({ ...good, paid_next: 'say' }), { node_key: 'say', node_type: 'send_message' as const, config: { text: 'Paid {{vars.payment_status}} {{vars.payment_link_url}}', next_node_key: 'thanks' } }, end('thanks'), end('sorry'), end('oops')];
    expect(validateFlowForActivation(flow, usesVars).filter((i) => i.node_key === 'say')).toEqual([]);
  });
  it('previews the link and lets the author pick the outcome', () => {
    const state = startPreview(nodes, 'pay');
    expect(state.waiting?.kind).toBe('branch');
    expect(state.waiting?.options.map((o) => o.id)).toEqual(['paid', 'expired', 'failed']);
    expect(state.messages.at(-1)?.text).toContain('Pay here');
    const paid = choose(state, 'paid');
    expect(paid.ended).toBe(true);
    expect(paid.messages.at(-1)?.note).toBe('end');
  });
});
