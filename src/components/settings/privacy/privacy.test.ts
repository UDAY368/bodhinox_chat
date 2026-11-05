// Privacy & access registration and the small pure helpers behind it.
import { describe, expect, it } from 'vitest';

import { RAIL_GROUPS, SECTION_META, SETTINGS_SECTIONS, resolveSection } from '../settings-sections';
import { completedSteps, dismissKey, ONBOARDING_STEPS } from '@/components/dashboard/onboarding-checklist';
import { normalizeWorkspaceName, WORKSPACE_NAME_MAX } from '@/lib/account/workspaces';

describe('Privacy & access section', () => {
  it('is a registered settings section in a rail group, deep-linkable as ?tab=privacy', () => {
    expect(SETTINGS_SECTIONS).toContain('privacy');
    expect(resolveSection('privacy')).toBe('privacy');
    expect(RAIL_GROUPS.map((g) => g.group)).toContain(SECTION_META.privacy.group);
  });
});

describe('onboarding checklist', () => {
  it('counts a step done from existing state; the team step needs a second member', () => {
    expect([...completedSteps({ whatsapp: 1, contacts: 0, templates: null, automation: 2, team: 1 })]).toEqual(['whatsapp', 'automation']);
    expect(completedSteps({ whatsapp: 1, contacts: 3, templates: 1, automation: 1, team: 2 }).size).toBe(ONBOARDING_STEPS.length);
  });

  it('dismisses per workspace and user', () => {
    expect(dismissKey('a', 'u')).not.toBe(dismissKey('b', 'u'));
    expect(dismissKey('a', 'u')).not.toBe(dismissKey('a', 'v'));
  });
});

describe('workspace names', () => {
  it('trims, collapses whitespace and control characters, and bounds the length', () => {
    expect(normalizeWorkspaceName('  Acme \n Retail  ')).toBe('Acme Retail');
    expect(normalizeWorkspaceName('   ')).toBeNull();
    expect(normalizeWorkspaceName(42)).toBeNull();
    expect(normalizeWorkspaceName('x'.repeat(WORKSPACE_NAME_MAX))).toHaveLength(WORKSPACE_NAME_MAX);
    expect(normalizeWorkspaceName('x'.repeat(WORKSPACE_NAME_MAX + 1))).toBeNull();
  });
});
