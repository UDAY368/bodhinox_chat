import { describe, expect, it } from 'vitest';
import {
  automationStepAvailableOn,
  automationStepsFor,
  automationTriggerAvailableOn,
  automationTriggersFor,
  CHANNELS,
  FLOW_TRIGGERS_BY_CHANNEL,
  flowNodesFor,
  flowTriggersFor,
  INSTAGRAM_NODE_SUPPORT,
  instagramMediaAllowed,
  isChannel,
  listFitsQuickReplies,
  nodeAvailableOn,
  scopeChannels,
  scopeIncludes,
  triggerAvailableOn,
  WHATSAPP_NODE_SUPPORT,
} from './capabilities';
import { FLOW_TRIGGER_TYPES, INSTAGRAM_ONLY_NODE_TYPES } from '@/lib/flows/types';
import { NODE_REGISTRY } from '@/lib/flows/node-registry';

describe('channel capabilities', () => {
  it('reads a missing scope as WhatsApp-only, so existing flows never run on Instagram', () => {
    expect(scopeIncludes(undefined, 'whatsapp')).toBe(true);
    expect(scopeIncludes(undefined, 'instagram')).toBe(false);
    expect(scopeIncludes('instagram', 'whatsapp')).toBe(false);
    expect(scopeChannels('any')).toEqual(['whatsapp', 'instagram']);
  });

  it('allows every node but the Instagram-only ones on WhatsApp and refuses WhatsApp-only nodes on Instagram', () => {
    for (const node of Object.keys(INSTAGRAM_NODE_SUPPORT) as (keyof typeof INSTAGRAM_NODE_SUPPORT)[])
      expect(nodeAvailableOn(node, 'whatsapp')).toEqual((INSTAGRAM_ONLY_NODE_TYPES as readonly string[]).includes(node)
        ? { ok: false, reason: 'unavailable_on_channel' } : { ok: true });
    for (const node of ['send_template', 'send_form', 'send_product', 'send_product_list', 'send_catalog', 'ask_location',
      'ask_address', 'book_appointment', 'conversion_event'] as const)
      expect(nodeAvailableOn(node, 'instagram')).toEqual({ ok: false, reason: 'unavailable_on_channel' });
    for (const node of ['send_message', 'send_buttons', 'collect_input', 'ask_media', 'condition', 'set_tag', 'set_attribute', 'ai_reply',
      'handoff', 'payment_link', 'send_storefront_link', ...INSTAGRAM_ONLY_NODE_TYPES] as const)
      expect(nodeAvailableOn(node, 'instagram', { text: 'hi' }).ok).toBe(true);
  });

  it('decides conditional nodes from their config', () => {
    expect(nodeAvailableOn('send_media', 'instagram', { media_type: 'image', media_url: 'https://x.test/a.png' }).ok).toBe(true);
    expect(nodeAvailableOn('send_media', 'instagram', { media_type: 'document', media_url: 'https://x.test/a.pdf' }).ok).toBe(true);
    expect(nodeAvailableOn('send_media', 'instagram', { media_type: 'document', media_url: 'https://x.test/a.docx' }).ok).toBe(false);
    const rows = (n: number) => ({ sections: [{ rows: Array.from({ length: n }, (_, i) => ({ reply_id: `r${i}`, title: `Row ${i}` })) }] });
    expect(listFitsQuickReplies(rows(11))).toBe(true);
    expect(nodeAvailableOn('send_list', 'instagram', rows(12))).toEqual({ ok: false, reason: 'unavailable_on_channel' });
    expect(nodeAvailableOn('send_message', 'instagram', { text: 'é'.repeat(501) })).toEqual({ ok: true, warning: 'text_over_limit' });
  });

  it('keeps WhatsApp-only triggers off Instagram and Instagram triggers off WhatsApp', () => {
    for (const trigger of ['keyword', 'first_inbound_message', 'manual', 'default_reply'] as const) {
      expect(triggerAvailableOn(trigger, 'instagram')).toBe(true);
      expect(triggerAvailableOn(trigger, 'whatsapp')).toBe(true);
    }
    for (const trigger of ['template_reply', 'order_received', 'ad_click'] as const) {
      expect(triggerAvailableOn(trigger, 'instagram')).toBe(false);
      expect(triggerAvailableOn(trigger, 'whatsapp')).toBe(true);
    }
    for (const trigger of ['ig_comment', 'ig_story_reply', 'ig_story_mention'] as const) {
      expect(triggerAvailableOn(trigger, 'instagram')).toBe(true);
      expect(triggerAvailableOn(trigger, 'whatsapp')).toBe(false);
    }
  });

  it('builds each channel flow palette from one exhaustive map', () => {
    expect(flowTriggersFor('whatsapp')).toEqual(['keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received', 'ad_click',
      'default_reply']);
    expect(flowTriggersFor('instagram')).toEqual(['keyword', 'first_inbound_message', 'manual', 'default_reply', 'ig_comment', 'ig_story_reply',
      'ig_story_mention']);
    for (const channel of CHANNELS)
      for (const trigger of FLOW_TRIGGERS_BY_CHANNEL[channel]) expect(triggerAvailableOn(trigger, channel)).toBe(true);
    // Every trigger type is offered by at least one channel.
    const offered = new Set(CHANNELS.flatMap((channel) => [...flowTriggersFor(channel)]));
    expect([...offered].sort()).toEqual([...FLOW_TRIGGER_TYPES].sort());
    // Every node that existed before Stage 2 stays on WhatsApp, so existing flows are unchanged.
    expect(flowNodesFor('whatsapp').sort()).toEqual(Object.keys(WHATSAPP_NODE_SUPPORT)
      .filter((node) => !(INSTAGRAM_ONLY_NODE_TYPES as readonly string[]).includes(node)).sort());
    for (const node of INSTAGRAM_ONLY_NODE_TYPES) expect(WHATSAPP_NODE_SUPPORT[node]).toBe('no');
    const instagram = flowNodesFor('instagram');
    expect(instagram).toEqual(expect.arrayContaining(['send_message', 'send_buttons', 'send_media', 'send_list', 'condition', 'ai_reply',
      ...INSTAGRAM_ONLY_NODE_TYPES]));
    for (const node of ['send_template', 'send_form', 'ask_location', 'ask_address', 'book_appointment'] as const) expect(instagram).not.toContain(node);
  });

  it('places every node type in both channel maps and the registry (capability matrix)', () => {
    const registry = Object.keys(NODE_REGISTRY).sort();
    expect(Object.keys(WHATSAPP_NODE_SUPPORT).sort()).toEqual(registry);
    expect(Object.keys(INSTAGRAM_NODE_SUPPORT).sort()).toEqual(registry);
    // No node is unavailable on both channels.
    const anywhere = new Set<string>([...flowNodesFor('whatsapp'), ...flowNodesFor('instagram')]);
    expect([...anywhere].sort()).toEqual(registry);
  });

  it('limits Instagram automations to message, contact and conversation triggers', () => {
    expect([...automationTriggersFor('instagram')].sort()).toEqual(['conversation_assigned', 'first_inbound_message', 'interactive_reply',
      'keyword_match', 'new_contact_created', 'new_message_received', 'tag_added']);
    for (const trigger of ['time_based', 'ad_click', 'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
      'appointment_completed', 'appointment_no_show'] as const) {
      expect(automationTriggerAvailableOn(trigger, 'instagram')).toBe(false);
      expect(automationTriggerAvailableOn(trigger, 'whatsapp')).toBe(true);
    }
    expect(automationTriggersFor('whatsapp')).toHaveLength(14);
  });

  it('keeps templates and list messages out of Instagram automation steps', () => {
    expect(automationStepsFor('whatsapp')).toHaveLength(14);
    expect(automationStepAvailableOn('send_template', 'instagram')).toBe(false);
    expect(automationStepAvailableOn('send_list', 'instagram')).toBe(false);
    for (const step of ['send_message', 'send_buttons', 'add_tag', 'remove_tag', 'assign_conversation', 'update_contact_field',
      'create_deal', 'wait', 'condition', 'send_webhook', 'close_conversation', 'notify_team'] as const) {
      expect(automationStepAvailableOn(step, 'instagram')).toBe(true);
      expect(automationStepAvailableOn(step, 'whatsapp')).toBe(true);
    }
    expect(automationStepsFor('instagram')).toHaveLength(12);
  });

  it('recognises only known channels', () => {
    expect(isChannel('whatsapp')).toBe(true);
    expect(isChannel('instagram')).toBe(true);
    for (const value of ['any', 'WhatsApp', '', null, 1]) expect(isChannel(value)).toBe(false);
  });

  it('allows only png/jpeg <= 8 MB, aac/m4a/wav audio and video <= 25 MB and pdf <= 25 MB in the composer', () => {
    expect(instagramMediaAllowed('image/png', 8 * 1024 * 1024)).toEqual({ ok: true, type: 'image' });
    expect(instagramMediaAllowed('image/png', 8 * 1024 * 1024 + 1)).toEqual({ ok: false });
    expect(instagramMediaAllowed('image/webp', 1000)).toEqual({ ok: false });
    expect(instagramMediaAllowed('video/mp4', 1000)).toEqual({ ok: true, type: 'video' });
    expect(instagramMediaAllowed('application/pdf', 1000)).toEqual({ ok: true, type: 'file' });
    expect(instagramMediaAllowed('application/zip', 1000)).toEqual({ ok: false });
    // Instagram plays AAC/M4A and WAV; the WhatsApp Ogg/Opus voice note is refused.
    expect(instagramMediaAllowed('audio/mp4', 1000)).toEqual({ ok: true, type: 'audio' });
    expect(instagramMediaAllowed('audio/wav', 1000)).toEqual({ ok: true, type: 'audio' });
    expect(instagramMediaAllowed('audio/ogg', 1000)).toEqual({ ok: false });
    expect(instagramMediaAllowed('audio/ogg; codecs=opus', 1000)).toEqual({ ok: false });
    expect(instagramMediaAllowed('audio/webm', 1000)).toEqual({ ok: false });
  });
});
