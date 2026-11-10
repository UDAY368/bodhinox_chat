import { describe, expect, it } from 'vitest';
import { legacyFlowsPath } from './legacy-path';

const ID = '11111111-1111-4111-8111-111111111111';

describe('legacyFlowsPath (old /flows links, Stage 1)', () => {
  it('sends /flows to the first enabled channel, WhatsApp first', () => {
    expect(legacyFlowsPath(['whatsapp'])).toBe('/whatsapp/flows');
    expect(legacyFlowsPath(['whatsapp', 'instagram'])).toBe('/whatsapp/flows');
    expect(legacyFlowsPath(['instagram'])).toBe('/instagram/flows');
    expect(legacyFlowsPath([])).toBe('/whatsapp/flows');
  });

  it("opens /flows/[id] in the flow's own section, even when that channel is off (its gate explains)", () => {
    expect(legacyFlowsPath(['whatsapp'], ID, 'whatsapp')).toBe(`/whatsapp/flows/${ID}`);
    expect(legacyFlowsPath(['whatsapp', 'instagram'], ID, 'instagram')).toBe(`/instagram/flows/${ID}`);
    expect(legacyFlowsPath(['whatsapp'], ID, 'instagram')).toBe(`/instagram/flows/${ID}`);
  });

  it("opens a legacy 'any' flow in WhatsApp unless only Instagram is enabled", () => {
    expect(legacyFlowsPath(['whatsapp', 'instagram'], ID, 'any')).toBe(`/whatsapp/flows/${ID}`);
    expect(legacyFlowsPath(['instagram'], ID, 'any')).toBe(`/instagram/flows/${ID}`);
  });

  it('sends a flow that was not found to the first enabled section, whose editor says so', () => {
    expect(legacyFlowsPath(['instagram'], ID, null)).toBe(`/instagram/flows/${ID}`);
    expect(legacyFlowsPath(['whatsapp'], 'not a uuid', null)).toBe('/whatsapp/flows/not%20a%20uuid');
  });
});
