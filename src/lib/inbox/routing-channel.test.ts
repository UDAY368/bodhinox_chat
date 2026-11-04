import { describe, expect, it } from 'vitest';
import { parseConditions, ruleMatches } from './routing';

// Phase 11: routing rules can match a conversation's channel.
const NUMBER = '5f0c1a0e-7d1e-4c55-9a43-3b0f2a6c1d11';
const base = { tagIds: new Set<string>(), text: 'hello', whatsappConfigId: NUMBER, withinWorkingHours: true };

describe('routing channel condition', () => {
  it('parses whatsapp and instagram, rejects anything else', () => {
    expect(parseConditions({ channel: 'instagram' })).toEqual({ channel: 'instagram' });
    expect(parseConditions({ channel: 'whatsapp' })).toEqual({ channel: 'whatsapp' });
    expect(parseConditions({ channel: null })).toEqual({});
    expect(parseConditions({ channel: 'sms' })).toBeNull();
    expect(parseConditions({ channel: ['instagram'] })).toBeNull();
  });

  it('matches only the conversation channel; an unknown channel matches no channel rule', () => {
    expect(ruleMatches({ channel: 'instagram' }, { ...base, whatsappConfigId: null, channel: 'instagram' })).toBe(true);
    expect(ruleMatches({ channel: 'instagram' }, base)).toBe(false);
    expect(ruleMatches({ channel: 'whatsapp' }, base)).toBe(false);
    expect(ruleMatches({ channel: 'whatsapp' }, { ...base, channel: 'whatsapp' })).toBe(true);
    expect(ruleMatches({ channel: 'whatsapp' }, { ...base, whatsappConfigId: null, channel: 'instagram' })).toBe(false);
    // A rule without a channel condition matches both, as before.
    expect(ruleMatches({}, { ...base, whatsappConfigId: null, channel: 'instagram' })).toBe(true);
  });

  it('never matches a number rule on an Instagram conversation', () => {
    expect(ruleMatches({ whatsapp_config_id: NUMBER }, { ...base, whatsappConfigId: null, channel: 'instagram' })).toBe(false);
  });
});
