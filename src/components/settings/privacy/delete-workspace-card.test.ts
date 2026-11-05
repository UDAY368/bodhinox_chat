// Phase 14 review (api-ui F5): the type-to-confirm check never passes on an empty
// workspace name (the account row failed to load).
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import { deletionNameConfirmed } from './delete-workspace-card';

describe('deletionNameConfirmed', () => {
  it('needs the loaded name typed exactly (trimmed)', () => {
    expect(deletionNameConfirmed(' Acme ', 'Acme')).toBe(true);
    expect(deletionNameConfirmed('acme', 'Acme')).toBe(false);
    expect(deletionNameConfirmed('', 'Acme')).toBe(false);
  });
  it('never confirms when the workspace name has not loaded', () => {
    expect(deletionNameConfirmed('', '')).toBe(false);
    expect(deletionNameConfirmed('  ', ' ')).toBe(false);
  });
});
