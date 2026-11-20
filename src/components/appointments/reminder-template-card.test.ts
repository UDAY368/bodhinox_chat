import { describe, expect, it } from 'vitest';
import { reminderTemplateState } from './reminder-template-card';

const row = (status: string | null) => ({ status, rejection_reason: null });

describe('reminderTemplateState', () => {
  it('reads the Meta review state of the actions template', () => {
    expect(reminderTemplateState([])).toBe('none');
    expect(reminderTemplateState([row('DRAFT')])).toBe('draft');
    expect(reminderTemplateState([row('PENDING')])).toBe('pending');
    expect(reminderTemplateState([row('REJECTED')])).toBe('rejected');
    expect(reminderTemplateState([row('approved')])).toBe('approved');
  });

  it('lets any approved language win', () => {
    expect(reminderTemplateState([row('REJECTED'), row('APPROVED')])).toBe('approved');
  });
});
