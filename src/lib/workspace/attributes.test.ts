import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ withTenant: vi.fn() }));
vi.mock('@/lib/db/tenant', () => db);

import { fillWorkspace, workspaceValuesFor } from './attributes';

describe('fillWorkspace', () => {
  it('replaces known keys, blanks unknown ones and leaves other placeholders alone', () => {
    expect(fillWorkspace('Mail {{workspace.support}} {{ workspace.support }} {{workspace.nope}} {{vars.name}}', { support: 'a@b.c' }))
      .toBe('Mail a@b.c a@b.c  {{vars.name}}');
  });

  it('never reads inherited object keys', () => {
    expect(fillWorkspace('{{workspace.constructor}}', {})).toBe('');
  });
});

describe('workspaceValuesFor', () => {
  it('does not query the database when the text has no workspace placeholder', async () => {
    expect(await workspaceValuesFor('00000000-0000-4000-8000-000000000001', 'Hi {{vars.name}}')).toEqual({});
    expect(db.withTenant).not.toHaveBeenCalled();
  });
});
