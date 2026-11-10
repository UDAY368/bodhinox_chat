import { describe, expect, it } from 'vitest';
import type { WorkspaceChannel } from '@/lib/channels/workspace';
import type { Channel } from '@/types';
import {
  channelOfConversation,
  channelStatusBanners,
  conversationInboxPath,
  inboxPath,
  inboxRedirectTarget,
  inScope,
  toSearchParams,
  type InboxScope,
} from './inbox-scope';

const ID = '11111111-1111-4111-8111-111111111111';

describe('channel of a conversation', () => {
  it('counts a legacy row without a channel as WhatsApp', () => {
    expect(channelOfConversation({ channel: null })).toBe('whatsapp');
    expect(channelOfConversation({})).toBe('whatsapp');
    expect(channelOfConversation(null)).toBe('whatsapp');
    expect(channelOfConversation({ channel: 'instagram' })).toBe('instagram');
  });

  it('keeps each channel inbox to its own rows; the All view takes every row', () => {
    expect(inScope('whatsapp', { channel: null })).toBe(true);
    expect(inScope('whatsapp', { channel: 'instagram' })).toBe(false);
    expect(inScope('instagram', { channel: null })).toBe(false);
    expect(inScope('instagram', { channel: 'instagram' })).toBe(true);
    expect(inScope('all', { channel: 'instagram' })).toBe(true);
    expect(inScope('all', { channel: null })).toBe(true);
  });

  it('names each inbox path', () => {
    expect(inboxPath('all')).toBe('/inbox');
    expect(inboxPath('whatsapp')).toBe('/whatsapp/inbox');
    expect(inboxPath('instagram')).toBe('/instagram/inbox');
  });
});

describe('inboxRedirectTarget', () => {
  const target = (scope: InboxScope, enabled: Channel[], conversationChannel: Channel | null, query = '') =>
    inboxRedirectTarget({ scope, enabled, conversationChannel, search: new URLSearchParams(query) });

  it('sends /inbox to the one enabled channel and keeps the query', () => {
    expect(target('all', ['whatsapp'], null)).toBe('/whatsapp/inbox');
    expect(target('all', ['instagram'], null, 'filter=unread')).toBe('/instagram/inbox?filter=unread');
    // An unknown or other-tenant ?c= id still goes to the channel inbox, which lists nothing for it.
    expect(target('all', ['whatsapp'], null, `c=${ID}`)).toBe(`/whatsapp/inbox?c=${ID}`);
  });

  it('keeps the All view while both channels are enabled', () => {
    expect(target('all', ['whatsapp', 'instagram'], null)).toBeNull();
    expect(target('all', ['whatsapp', 'instagram'], 'instagram', `c=${ID}`)).toBeNull();
  });

  it('opens an old /inbox?c= link in its conversation\'s channel inbox', () => {
    expect(target('all', ['whatsapp'], 'whatsapp', `c=${ID}&filter=open`)).toBe(`/whatsapp/inbox?c=${ID}&filter=open`);
    expect(target('all', ['instagram'], 'instagram', `c=${ID}`)).toBe(`/instagram/inbox?c=${ID}`);
    // Its channel is off: the All view lists and opens it, so the link still works.
    expect(target('all', ['whatsapp'], 'instagram', `c=${ID}`)).toBeNull();
  });

  it('moves a ?c= link from the wrong channel inbox to the right one', () => {
    expect(target('whatsapp', ['whatsapp', 'instagram'], 'instagram', `c=${ID}`)).toBe(`/instagram/inbox?c=${ID}`);
    expect(target('instagram', ['whatsapp', 'instagram'], 'whatsapp', `c=${ID}`)).toBe(`/whatsapp/inbox?c=${ID}`);
    // The conversation's channel is off: the All view, which then stays (no loop).
    const off = target('whatsapp', ['whatsapp'], 'instagram', `c=${ID}`);
    expect(off).toBe(`/inbox?c=${ID}`);
    expect(target('all', ['whatsapp'], 'instagram', `c=${ID}`)).toBeNull();
  });

  it('renders a channel inbox for its own or an unknown conversation', () => {
    expect(target('whatsapp', ['whatsapp'], null)).toBeNull();
    expect(target('whatsapp', ['whatsapp', 'instagram'], 'whatsapp', `c=${ID}`)).toBeNull();
    expect(target('instagram', ['instagram'], null, `c=${ID}`)).toBeNull();
    // A turned-off channel's inbox renders its layout's off state, never a redirect.
    expect(target('instagram', ['whatsapp'], null)).toBeNull();
  });

  it('never redirects a page to itself', () => {
    const scopes: InboxScope[] = ['all', 'whatsapp', 'instagram'];
    const sets: Channel[][] = [['whatsapp'], ['instagram'], ['whatsapp', 'instagram']];
    const convs: (Channel | null)[] = [null, 'whatsapp', 'instagram'];
    for (const scope of scopes) for (const enabled of sets) for (const conv of convs) {
      const first = target(scope, enabled, conv, `c=${ID}`);
      if (!first) continue;
      expect(first.split('?')[0]).not.toBe(inboxPath(scope));
      // Following it lands on a page that does not redirect again.
      const next = first.split('?')[0] === '/inbox' ? 'all' : (first.split('/')[1] as Channel);
      expect(target(next, enabled, conv, `c=${ID}`)).toBeNull();
    }
  });
});

describe('conversationInboxPath', () => {
  it('opens a conversation in its channel inbox, or the All view while that channel is off', () => {
    expect(conversationInboxPath('instagram', ['whatsapp', 'instagram'], ID)).toBe(`/instagram/inbox?c=${ID}`);
    expect(conversationInboxPath('whatsapp', ['whatsapp'], ID)).toBe(`/whatsapp/inbox?c=${ID}`);
    expect(conversationInboxPath('instagram', ['whatsapp'], ID)).toBe(`/inbox?c=${ID}`);
  });
});

describe('channelStatusBanners', () => {
  const state = (channel: Channel, value: WorkspaceChannel['state']): WorkspaceChannel => ({
    channel, available: true, unavailableReason: null, enabled: value !== 'off', explicit: false,
    connection: value === 'live' ? 'live' : value === 'attention' ? 'attention' : 'none', state: value,
  });
  const channels = (wa: WorkspaceChannel['state'], ig: WorkspaceChannel['state']) =>
    ({ whatsapp: state('whatsapp', wa), instagram: state('instagram', ig) });
  const none = { whatsappBannerShown: false, instagramBannersShown: false };
  const names = (list: WorkspaceChannel[]) => list.map((c) => `${c.channel}:${c.state}`);

  it('shows nothing before the channel state loads', () => {
    expect(channelStatusBanners('whatsapp', undefined, none)).toEqual([]);
  });

  it('keeps each channel\'s banners in its own inbox', () => {
    // The WhatsApp inbox never shows an Instagram banner, and the other way round.
    expect(names(channelStatusBanners('whatsapp', channels('live', 'attention'), none))).toEqual([]);
    expect(names(channelStatusBanners('whatsapp', channels('live', 'setup'), none))).toEqual([]);
    expect(names(channelStatusBanners('instagram', channels('attention', 'live'), none))).toEqual([]);
  });

  it('WhatsApp inbox: attention, unless its "not connected" banner already shows', () => {
    expect(names(channelStatusBanners('whatsapp', channels('attention', 'off'), none))).toEqual(['whatsapp:attention']);
    expect(channelStatusBanners('whatsapp', channels('attention', 'off'), { ...none, whatsappBannerShown: true })).toEqual([]);
    // Not connected is today's "WhatsApp is not connected" banner, unchanged.
    expect(channelStatusBanners('whatsapp', channels('setup', 'off'), none)).toEqual([]);
  });

  it('Instagram inbox: connect prompt while not connected; attention unless an account banner shows', () => {
    expect(names(channelStatusBanners('instagram', channels('live', 'setup'), none))).toEqual(['instagram:setup']);
    expect(names(channelStatusBanners('instagram', channels('live', 'attention'), none))).toEqual(['instagram:attention']);
    expect(channelStatusBanners('instagram', channels('live', 'attention'), { ...none, instagramBannersShown: true })).toEqual([]);
    expect(channelStatusBanners('instagram', channels('live', 'live'), none)).toEqual([]);
  });

  it('All view: every channel that needs attention', () => {
    expect(names(channelStatusBanners('all', channels('attention', 'attention'), none))).toEqual(['whatsapp:attention', 'instagram:attention']);
    expect(names(channelStatusBanners('all', channels('setup', 'live'), none))).toEqual([]);
  });
});

describe('toSearchParams', () => {
  it('keeps repeated keys and drops missing values', () => {
    expect(toSearchParams({ c: ID, tag: ['a', 'b'], none: undefined }).toString()).toBe(`c=${ID}&tag=a&tag=b`);
  });
});
