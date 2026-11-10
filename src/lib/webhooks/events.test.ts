import { describe, it, expect } from 'vitest';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DESCRIPTIONS,
  WEBHOOK_EVENT_SCOPE,
  endpointChannels,
  isWebhookEvent,
  normalizeEvents,
  normalizeWebhookChannels,
} from './events';

describe('isWebhookEvent', () => {
  it('accepts every declared event and rejects others', () => {
    for (const e of WEBHOOK_EVENTS) expect(isWebhookEvent(e)).toBe(true);
    expect(isWebhookEvent('message.deleted')).toBe(false);
    expect(isWebhookEvent(42)).toBe(false);
  });
});

describe('every event has a description', () => {
  it('covers the vocabulary', () => {
    for (const e of WEBHOOK_EVENTS) {
      expect(WEBHOOK_EVENT_DESCRIPTIONS[e]).toBeTruthy();
    }
  });
});

describe('normalizeEvents', () => {
  it('de-duplicates a valid list', () => {
    expect(
      normalizeEvents(['message.received', 'message.received', 'conversation.created'])
    ).toEqual(['message.received', 'conversation.created']);
  });

  it('rejects an unknown event', () => {
    expect(normalizeEvents(['message.received', 'nope'])).toBeNull();
  });

  it('rejects a non-array and an empty array', () => {
    expect(normalizeEvents('message.received')).toBeNull();
    expect(normalizeEvents([])).toBeNull();
  });
});

describe('webhook channels (Stage 2)', () => {
  it('normalizes a channel list to canonical order without duplicates', () => {
    expect(normalizeWebhookChannels(['instagram', 'whatsapp', 'instagram'])).toEqual(['whatsapp', 'instagram']);
    expect(normalizeWebhookChannels(['instagram'])).toEqual(['instagram']);
  });
  it('rejects an empty list, unknown channels and non-arrays', () => {
    expect(normalizeWebhookChannels([])).toBeNull();
    expect(normalizeWebhookChannels(['sms'])).toBeNull();
    expect(normalizeWebhookChannels(['whatsapp', 7])).toBeNull();
    expect(normalizeWebhookChannels('instagram')).toBeNull();
  });
  it('reads a stored row, defaulting to WhatsApp only', () => {
    expect(endpointChannels(undefined)).toEqual(['whatsapp']);
    expect(endpointChannels(['instagram', 'x'])).toEqual(['instagram']);
  });
  it('scopes WhatsApp-only events to WhatsApp and leaves business events to every endpoint', () => {
    for (const e of WEBHOOK_EVENTS) expect(['conversation', 'whatsapp', 'workspace']).toContain(WEBHOOK_EVENT_SCOPE[e]);
    expect(WEBHOOK_EVENT_SCOPE['message.received']).toBe('conversation');
    expect(WEBHOOK_EVENT_SCOPE['broadcast.completed']).toBe('whatsapp');
    expect(WEBHOOK_EVENT_SCOPE['template.status_updated']).toBe('whatsapp');
    expect(WEBHOOK_EVENT_SCOPE['order.paid']).toBe('workspace');
  });
});
