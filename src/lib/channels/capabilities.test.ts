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

describe('channel capabilities', () => {
  it('reads a missing scope as WhatsApp-only, so existing flows never run on Instagram', () => {
    expect(scopeIncludes(undefined, 'whatsapp')).toBe(true);
    expect(scopeIncludes(undefined, 'instagram')).toBe(false);
    expect(scopeIncludes('instagram', 'whatsapp')).toBe(false);
    expect(scopeChannels('any')).toEqual(['whatsapp', 'instagram']);
  });

  it('allows every node on WhatsApp and refuses WhatsApp-only nodes on Instagram', () => {
    for (const node of Object.keys(INSTAGRAM_NODE_SUPPORT) as (keyof typeof INSTAGRAM_NODE_SUPPORT)[])
      expect(nodeAvailableOn(node, 'whatsapp')).toEqual({ ok: true });
    for (const node of ['send_template', 'send_form', 'send_product', 'send_product_list', 'send_catalog', 'ask_location',
      'ask_address', 'book_appointment', 'conversion_event', 'ai_reply'] as const)
      expect(nodeAvailableOn(node, 'instagram')).toEqual({ ok: false, reason: 'unavailable_on_channel' });
    for (const node of ['send_message', 'send_buttons', 'collect_input', 'condition', 'handoff', 'payment_link', 'send_storefront_link'] as const)
      expect(nodeAvailableOn(node, 'instagram', { text: 'hi' }).ok).toBe(true);
  });

  it('decides conditional nodes from their config', () => {
    expect(nodeAvailableOn('send_media', 'instagram', { media_type: 'image', media_url: 'https://x.test/a.png' }).ok).toBe(true);
    expect(nodeAvailableOn('send_media', 'instagram', { media_type: 'document', media_url: 'https://x.test/a.pdf' }).ok).toBe(true);
    expect(nodeAvailableOn('send_media', 'instagram', { media_type: 'document', media_url: 'https://x.test/a.docx' }).ok).toBe(false);
    const rows = (n: number) => ({ sections: [{ rows: Array.from({ length: n }, (_, i) => ({ reply_id: `r${i}`, title: `Row ${i}` })) }] });
    expect(listFitsQuickReplies(rows(13))).toBe(true);
    expect(nodeAvailableOn('send_list', 'instagram', rows(14))).toEqual({ ok: false, reason: 'unavailable_on_channel' });
    expect(nodeAvailableOn('send_message', 'instagram', { text: 'é'.repeat(501) })).toEqual({ ok: true, warning: 'text_over_limit' });
  });

  it('limits Instagram triggers to keyword, first message and manual', () => {
    expect(triggerAvailableOn('keyword', 'instagram')).toBe(true);
    expect(triggerAvailableOn('manual', 'instagram')).toBe(true);
    for (const trigger of ['template_reply', 'order_received', 'ad_click'] as const) {
      expect(triggerAvailableOn(trigger, 'instagram')).toBe(false);
      expect(triggerAvailableOn(trigger, 'whatsapp')).toBe(true);
    }
  });

  it('builds each channel flow palette from one map', () => {
    expect(flowTriggersFor('whatsapp')).toEqual(['keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received', 'ad_click']);
    expect(flowTriggersFor('instagram')).toEqual(['keyword', 'first_inbound_message', 'manual']);
    for (const channel of CHANNELS)
      for (const trigger of FLOW_TRIGGERS_BY_CHANNEL[channel]) expect(triggerAvailableOn(trigger, channel)).toBe(true);
    // Every node that exists today stays on WhatsApp, so existing flows are unchanged.
    expect(flowNodesFor('whatsapp').sort()).toEqual(Object.keys(WHATSAPP_NODE_SUPPORT).sort());
    expect(Object.values(WHATSAPP_NODE_SUPPORT).every((s) => s === 'yes')).toBe(true);
    const instagram = flowNodesFor('instagram');
    expect(instagram).toEqual(expect.arrayContaining(['send_message', 'send_buttons', 'send_media', 'send_list', 'condition']));
    for (const node of ['send_template', 'send_form', 'ask_location', 'ai_reply'] as const) expect(instagram).not.toContain(node);
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
