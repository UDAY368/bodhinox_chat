// The Instagram quick-automation wizards (Stage 2, plan item 10): strict
// answers, Instagram's limits, and a draft that is an ordinary editable
// Instagram flow (the same graphs as the starter templates).
import { describe, expect, it } from 'vitest';

import { deriveCanvasEdges, extraPorts, outgoingSlots } from '@/lib/flows/edges';
import { validateFlowForActivation, type ValidationIssue } from '@/lib/flows/validate';
import { getFlowTemplate } from '@/lib/flows/templates';
import { NODE_META, type BuilderNode } from '@/components/flows/shared';
import { buildWizardFlow, parseWizardInput, WizardInputError, type WizardFlowDraft } from './wizards';

const NOW = new Date('2026-11-10T09:00:00.000Z');

const commentLinks = {
  wizard: 'comment_links',
  keywords: ['LINK', ' link ', 'guide'],
  public_replies: ['Sent you a DM!'],
  message: 'Thanks! Tap below for the link.',
  link_url: 'https://shop.example.com/guide',
};
const growFollowers = {
  wizard: 'grow_followers',
  post_scope: 'next',
  keywords: ['freebie'],
  message: 'Your freebie is ready.',
  reward_url: 'https://shop.example.com/freebie',
};
const storyLeads = {
  wizard: 'story_leads',
  email_prompt: "What's your email?",
  thanks: 'Thanks!',
};

function refused(body: unknown): { field: string; problem: string } {
  try {
    parseWizardInput(body);
  } catch (error) {
    if (error instanceof WizardInputError) return { field: error.field, problem: error.problem };
    throw error;
  }
  throw new Error('accepted');
}


/** Publish (activation) validation errors for a wizard draft. */
function publishErrors(draft: WizardFlowDraft): ValidationIssue[] {
  const nodes = draft.nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config as Record<string, unknown> }));
  return validateFlowForActivation({
    name: draft.name, trigger_type: draft.trigger_type, trigger_config: draft.trigger_config as Record<string, unknown>,
    entry_node_id: draft.entry_node_id, channel_scope: 'instagram',
  }, nodes).filter((issue) => issue.severity === 'error');
}

describe('parseWizardInput', () => {
  it('fills optional copy from the defaults and tidies the keywords', () => {
    const input = parseWizardInput(commentLinks);
    expect(input).toMatchObject({
      wizard: 'comment_links', post_scope: 'any', keywords: ['LINK', 'guide'], public_replies: ['Sent you a DM!'],
      opt_in_label: 'Send me the link', card_title: "Here's the link you asked for", link_label: 'Open link',
    });
    expect(parseWizardInput(storyLeads)).toMatchObject({ keywords: [], reactions: false, email_error: expect.stringContaining('email') });
  });

  it('refuses unknown wizards, unknown fields and non-object bodies', () => {
    expect(refused(null)).toEqual({ field: 'body', problem: 'invalid' });
    expect(refused([])).toEqual({ field: 'body', problem: 'invalid' });
    expect(refused({ ...commentLinks, wizard: 'giveaway' })).toEqual({ field: 'wizard', problem: 'invalid' });
    expect(refused({ ...commentLinks, channel_scope: 'whatsapp' })).toEqual({ field: 'channel_scope', problem: 'invalid' });
    // A story wizard takes no post choice; a comment wizard no reactions.
    expect(refused({ ...storyLeads, post_scope: 'any' })).toEqual({ field: 'post_scope', problem: 'invalid' });
    expect(refused({ ...commentLinks, reactions: true })).toEqual({ field: 'reactions', problem: 'invalid' });
  });

  it("keeps every text, button and link within Instagram's limits", () => {
    expect(refused({ ...commentLinks, link_url: 'http://shop.example.com' })).toEqual({ field: 'link_url', problem: 'url' });
    expect(refused({ ...commentLinks, link_url: 'javascript:alert(1)' })).toEqual({ field: 'link_url', problem: 'url' });
    expect(refused({ ...commentLinks, link_url: undefined })).toEqual({ field: 'link_url', problem: 'url' });
    expect(refused({ ...commentLinks, opt_in_label: 'x'.repeat(21) })).toEqual({ field: 'opt_in_label', problem: 'button' });
    expect(refused({ ...commentLinks, card_title: 'x'.repeat(81) })).toEqual({ field: 'card_title', problem: 'title' });
    expect(refused({ ...commentLinks, message: 'é'.repeat(501) })).toEqual({ field: 'message', problem: 'text' });
    expect(refused({ ...commentLinks, message: '   ' })).toEqual({ field: 'message', problem: 'text' });
    expect(refused({ ...commentLinks, message: 42 })).toEqual({ field: 'message', problem: 'text' });
    expect(refused({ ...commentLinks, public_replies: ['a', 'b', 'c', 'd'] })).toEqual({ field: 'public_replies', problem: 'publicReply' });
    expect(refused({ ...commentLinks, keywords: ['x'.repeat(101)] })).toEqual({ field: 'keywords', problem: 'keywords' });
    expect(refused({ ...commentLinks, keywords: Array.from({ length: 51 }, (_, i) => `k${i}`) })).toEqual({ field: 'keywords', problem: 'keywords' });
    expect(refused({ ...storyLeads, reactions: 'yes' })).toEqual({ field: 'reactions', problem: 'invalid' });
    // An emoji counts once toward a 20-character button.
    expect(parseWizardInput({ ...commentLinks, opt_in_label: '🎁'.repeat(20) }).wizard).toBe('comment_links');
  });

  it('takes any post, the next post, or 1–50 specific posts', () => {
    expect(parseWizardInput({ ...commentLinks, post_scope: 'specific', media_ids: ['1789', '1789', '42'] }))
      .toMatchObject({ post_scope: 'specific', media_ids: ['1789', '42'] });
    expect(refused({ ...commentLinks, post_scope: 'specific' })).toEqual({ field: 'media_ids', problem: 'posts' });
    expect(refused({ ...commentLinks, post_scope: 'specific', media_ids: ['abc'] })).toEqual({ field: 'media_ids', problem: 'posts' });
    expect(refused({ ...commentLinks, post_scope: 'any', media_ids: ['1789'] })).toEqual({ field: 'media_ids', problem: 'posts' });
    expect(refused({ ...commentLinks, post_scope: 'last' })).toEqual({ field: 'post_scope', problem: 'posts' });
  });
});

describe('buildWizardFlow', () => {
  const drafts = [
    ['comment_links', buildWizardFlow(parseWizardInput(commentLinks), NOW)],
    ['grow_followers', buildWizardFlow(parseWizardInput(growFollowers), NOW)],
    ['story_leads', buildWizardFlow(parseWizardInput({ ...storyLeads, keywords: ['info'], reactions: true }), NOW)],
  ] as const;

  it.each(drafts)('%s is an ordinary editable flow: known steps, every step connected, nothing dangling', (_wizard, draft) => {
    const nodes: BuilderNode[] = draft.nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config as Record<string, unknown> }));
    for (const node of nodes) expect(NODE_META[node.node_type], node.node_type).toBeDefined();
    const edges = deriveCanvasEdges(nodes);
    const targets = new Set(edges.map((e) => e.target));
    for (const node of nodes) if (node.node_key !== draft.entry_node_id) expect(targets.has(node.node_key), node.node_key).toBe(true);
    // Every main port is wired to an existing step (an unwired optional port, such as "attempts used up",
    // follows the flow's fallback policy as in the other starters).
    for (const node of nodes) {
      const optional = new Set(extraPorts(node).map((port) => port.handle));
      for (const slot of outgoingSlots(node).filter((s) => !optional.has(s.id))) expect(edges.some((e) => e.source === node.node_key && e.sourceHandle === slot.id), `${node.node_key}:${slot.id}`).toBe(true);
    }
    expect(draft.entry_node_id).toBe('start');
  });

  it.each(drafts)('%s passes publish validation for Instagram as-is', (_wizard, draft) => {
    expect(publishErrors(draft)).toEqual([]);
  });

  it('turns comment answers into an ig_comment trigger and the comment-to-DM graph', () => {
    const draft = drafts[0][1];
    expect(draft).toMatchObject({
      name: 'Auto-DM links from comments: LINK',
      trigger_type: 'ig_comment',
      trigger_config: { post_scope: 'any', include_keywords: ['LINK', 'guide'], include_mode: 'contains', public_replies: ['Sent you a DM!'] },
    });
    expect(draft.nodes.map((n) => [n.node_key, n.node_type])).toEqual([
      ['start', 'start'], ['opening', 'ig_private_reply'], ['link', 'send_card'], ['end', 'end'],
    ]);
    expect(draft.nodes[2].config).toMatchObject({
      card: { buttons: [{ type: 'web_url', title: 'Open link', url: 'https://shop.example.com/guide' }] },
    });
    // The same graph as the starter template, with the customer's own copy and link.
    expect(getFlowTemplate('ig_link_drop')!.nodes.map((n) => [n.node_key, n.node_type])).toEqual(draft.nodes.map((n) => [n.node_key, n.node_type]));
  });

  it('listens on the next post published after the wizard ran', () => {
    expect(drafts[1][1].trigger_config).toEqual({
      post_scope: 'next', next_after: NOW.toISOString(), include_keywords: ['freebie'], include_mode: 'contains',
    });
  });

  it('builds the follow gate: a profile check that loops back after the "I followed" tap', () => {
    const nodes = new Map(drafts[1][1].nodes.map((n) => [n.node_key, n]));
    expect(nodes.get('opening')).toMatchObject({ node_type: 'ig_private_reply', config: { opt_in_label: 'Get it', next_node_key: 'check_follow' } });
    expect(nodes.get('check_follow')).toMatchObject({
      node_type: 'condition', config: { subject: 'ig_profile', subject_key: 'follows_business', true_next: 'reward', false_next: 'ask_follow' },
    });
    expect(nodes.get('ask_follow')).toMatchObject({ node_type: 'send_buttons', config: { buttons: [{ title: 'I followed', next_node_key: 'check_follow' }] } });
    expect(nodes.get('reward')).toMatchObject({ node_type: 'send_card', config: { card: { buttons: [{ url: 'https://shop.example.com/freebie' }] } } });
  });

  it('turns story answers into an ig_story_reply trigger that collects an email', () => {
    const draft = drafts[2][1];
    expect(draft).toMatchObject({
      name: 'Leads from story replies: info',
      trigger_type: 'ig_story_reply',
      trigger_config: { keywords: ['info'], match_mode: 'contains', reactions: true },
    });
    expect(draft.nodes.find((n) => n.node_key === 'ask_email')).toMatchObject({ node_type: 'collect_input', config: { validation: 'email', var_key: 'email' } });
    expect(draft.nodes.find((n) => n.node_key === 'save_email')).toMatchObject({ node_type: 'set_attribute', config: { target: 'contact_field', key: 'email' } });
    expect(buildWizardFlow(parseWizardInput(storyLeads), NOW).trigger_config).toEqual({ reactions: false });
  });

  it('omits the public replies and keywords when none are given (every comment, DM only)', () => {
    const draft = buildWizardFlow(parseWizardInput({ ...commentLinks, keywords: [], public_replies: [' '] }), NOW);
    expect(draft.trigger_config).toEqual({ post_scope: 'any' });
    expect(draft.name).toBe('Auto-DM links from comments');
  });
});
