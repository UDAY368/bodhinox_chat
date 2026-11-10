// Phase 14 review (api-ui F6): the team step is done with a second member or a
// pending invitation, as its documented rule says. Stage 1: the steps follow the
// workspace's enabled channels.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));
vi.mock('@/lib/data/client', () => ({ createClient: vi.fn() }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({}) }));

import { completedSteps, ONBOARDING_STEPS, onboardingSteps, STEP_HREF, teamCount } from './onboarding-checklist';

describe('team step', () => {
  it('counts open invitations with members', () => {
    expect(completedSteps({ team: teamCount(1, 1) }).has('team')).toBe(true);
    expect(completedSteps({ team: teamCount(2, 0) }).has('team')).toBe(true);
    expect(completedSteps({ team: teamCount(1, 0) }).has('team')).toBe(false);
    // Invitations unreadable (a member below admin): members alone decide.
    expect(completedSteps({ team: teamCount(1, null) }).has('team')).toBe(false);
    expect(teamCount(null, null)).toBeNull();
  });
});

describe('steps per channel set (Stage 1)', () => {
  it('a WhatsApp workspace keeps the steps it had before channels existed', () => {
    expect(onboardingSteps(['whatsapp'])).toEqual(['whatsapp', 'contacts', 'templates', 'automation', 'team']);
    expect([...ONBOARDING_STEPS]).toEqual(onboardingSteps(['whatsapp']));
    // No channel enabled (the server never allows it) still shows the WhatsApp steps.
    expect(onboardingSteps([])).toEqual(onboardingSteps(['whatsapp']));
  });

  it('an Instagram-only workspace sees no WhatsApp step', () => {
    const steps = onboardingSteps(['instagram']);
    expect(steps).toEqual(['instagramConnect', 'instagramAllowMessages', 'instagramCommentAutomation', 'automation', 'team']);
    for (const whatsappStep of ['whatsapp', 'contacts', 'templates'] as const) expect(steps).not.toContain(whatsappStep);
  });

  it('both channels list WhatsApp steps, then Instagram steps, then the shared ones, whatever the order given', () => {
    expect(onboardingSteps(['instagram', 'whatsapp'])).toEqual([
      'whatsapp', 'contacts', 'templates', 'instagramConnect', 'instagramAllowMessages', 'instagramCommentAutomation', 'automation', 'team',
    ]);
  });

  it('counts completion over the given steps only', () => {
    const steps = onboardingSteps(['instagram']);
    const done = completedSteps({ whatsapp: 1, instagramConnect: 1, instagramAllowMessages: 0, instagramCommentAutomation: null, automation: 1 }, steps);
    expect([...done]).toEqual(['instagramConnect', 'automation']);
  });

  it('links Instagram steps to the Instagram settings and the Comments page', () => {
    expect(STEP_HREF.instagramConnect).toBe('/settings?tab=instagram');
    expect(STEP_HREF.instagramCommentAutomation).toBe('/instagram/comments');
    expect(STEP_HREF.whatsapp).toBe('/settings?tab=whatsapp');
  });
});
