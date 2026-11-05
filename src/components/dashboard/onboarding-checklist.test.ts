// Phase 14 review (api-ui F6): the team step is done with a second member or a
// pending invitation, as its documented rule says.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));
vi.mock('@/lib/data/client', () => ({ createClient: vi.fn() }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({}) }));

import { completedSteps, teamCount } from './onboarding-checklist';

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
