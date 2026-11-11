import { describe, expect, it } from 'vitest';
import {
  ALL_INBOXES_PATH,
  CHANNELS_SETTINGS_PATH,
  channelFromPath,
  channelPath,
  channelSettingsPath,
  firstEnabledChannel,
  sectionForFlowScope,
} from './routes';

const ID = '33333333-3333-4333-8333-333333333333';

describe('channel routes', () => {
  it('builds each section URL under its channel', () => {
    expect(channelPath('whatsapp', 'inbox')).toBe('/whatsapp/inbox');
    expect(channelPath('instagram', 'inbox', ID)).toBe(`/instagram/inbox?c=${ID}`);
    expect(channelPath('instagram', 'flows')).toBe('/instagram/flows');
    expect(channelPath('whatsapp', 'flows', ID)).toBe(`/whatsapp/flows/${ID}`);
    expect(channelPath('whatsapp', 'automations')).toBe('/whatsapp/automations');
    expect(channelPath('instagram', 'automations', ID)).toBe(`/instagram/automations/${ID}/edit`);
    expect(channelPath('instagram', 'automationNew')).toBe('/instagram/automations/new');
    expect(channelPath('whatsapp', 'automationLogs', ID)).toBe(`/whatsapp/automations/${ID}/logs`);
  });

  it('keeps WhatsApp tools on their old URLs and puts Instagram tools under /instagram', () => {
    expect(channelPath('whatsapp', 'broadcasts')).toBe('/broadcasts');
    expect(channelPath('whatsapp', 'templates')).toBe('/settings?tab=templates');
    expect(channelPath('whatsapp', 'forms')).toBe('/forms');
    expect(channelPath('whatsapp', 'ads')).toBe('/ads');
    expect(channelPath('instagram', 'comments')).toBe('/instagram/comments');
    expect(channelPath('instagram', 'conversationStarters')).toBe('/instagram/conversation-starters');
    expect(channelPath('instagram', 'defaultReply')).toBe('/instagram/default-reply');
    expect(channelPath('instagram', 'quickAutomations')).toBe('/instagram/quick-automations');
    // A tool asked for on the wrong channel is a programming error, not a broken link.
    expect(() => (channelPath as (c: string, s: string) => string)('instagram', 'broadcasts')).toThrow();
    expect(() => (channelPath as (c: string, s: string) => string)('whatsapp', 'comments')).toThrow();
    expect(() => (channelPath as (c: string, s: string) => string)('whatsapp', 'constructor')).toThrow();
  });

  it('never lets an id escape its path segment', () => {
    expect(channelPath('whatsapp', 'flows', '../settings')).toBe('/whatsapp/flows/..%2Fsettings');
    expect(channelPath('whatsapp', 'inbox', 'a&b=c')).toBe('/whatsapp/inbox?c=a%26b%3Dc');
    expect(() => channelPath('whatsapp', 'automationLogs')).toThrow();
  });

  it('links to settings and the all-channels inbox', () => {
    expect(channelSettingsPath('whatsapp')).toBe('/settings?tab=whatsapp');
    expect(channelSettingsPath('instagram')).toBe('/settings?tab=instagram');
    expect(CHANNELS_SETTINGS_PATH).toBe('/settings?tab=channels');
    expect(ALL_INBOXES_PATH).toBe('/inbox');
  });

  it('reads the channel from a pathname', () => {
    expect(channelFromPath('/instagram/flows/abc')).toBe('instagram');
    expect(channelFromPath('/whatsapp')).toBe('whatsapp');
    expect(channelFromPath('/inbox')).toBeNull();
    expect(channelFromPath('/whatsappx/inbox')).toBeNull();
  });

  it('sends channel-less links to the first enabled channel, WhatsApp first', () => {
    expect(firstEnabledChannel(['whatsapp', 'instagram'])).toBe('whatsapp');
    expect(firstEnabledChannel(['instagram'])).toBe('instagram');
    expect(firstEnabledChannel([])).toBe('whatsapp');
    expect(sectionForFlowScope('instagram', ['whatsapp'])).toBe('instagram');
    expect(sectionForFlowScope('any', ['whatsapp', 'instagram'])).toBe('whatsapp');
    expect(sectionForFlowScope('any', ['instagram'])).toBe('instagram');
    expect(sectionForFlowScope(undefined, ['instagram'])).toBe('whatsapp');
  });
});
