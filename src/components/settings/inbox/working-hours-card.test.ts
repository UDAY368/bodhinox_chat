// Stage 5: the Working hours card saves only its own fields, so it never
// reverts the pause, assignment or visibility settings another card changed
// after this one loaded; and, as a client component, it reads the Stage 5
// defaults from @/types rather than the server-side settings module.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_INBOX_SETTINGS } from '@/lib/inbox/working-hours';
import { workingHoursBody } from './working-hours-card';

describe('WorkingHoursCard save body', () => {
  it('leaves the Stage 5 settings out, keeping every working-hours field', () => {
    const settings = {
      ...DEFAULT_INBOX_SETTINGS, working_hours: {}, instagram_away_message_enabled: true,
      agent_reply_pause_minutes: 60, auto_assign_mode: 'basic' as const, agent_visibility: 'assigned_or_team' as const,
    };
    const body = workingHoursBody(settings);
    for (const key of ['agent_reply_pause_minutes', 'auto_assign_mode', 'agent_visibility']) expect(body).not.toHaveProperty(key);
    expect(body).toMatchObject({ timezone: settings.timezone, instagram_away_message_enabled: true, working_hours: {} });
    // The input is not mutated (it is the card's state).
    expect(settings.auto_assign_mode).toBe('basic');
  });

  it('imports nothing but types from the server-side settings module', () => {
    const source = readFileSync(path.join(__dirname, 'working-hours-card.tsx'), 'utf8');
    const imports = source.match(/^import[^;]*from ["']@\/lib\/inbox\/inbox-settings["'];?$/gm) ?? [];
    for (const line of imports) expect(line, line).toMatch(/^import type /);
  });
});
