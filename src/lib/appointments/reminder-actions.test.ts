import { describe, expect, it } from 'vitest';
import { getLibraryTemplate } from '@/lib/whatsapp/template-library';
import { appointmentTemplateRefusal } from './template-check';
import { reminderChannel } from './customer-send';
import { intakeApplies, intakeRefusalOutcome } from './intake-form';
import {
  actionButtonIndexes, customerCanChange, decideReminderAction, parseReminderActionId, REMINDER_ACTIONS_TEMPLATE,
  reminderActionId, replyKey,
} from './reminder-actions';

const ID = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-12-01T10:00:00.000Z');
const row = {
  contact_id: CONTACT, status: 'confirmed' as const, version: 3, start_at: new Date('2026-12-02T10:00:00.000Z'),
  cancel_reason: null, attendance_confirmed_at: null,
};

describe('reminder button ids', () => {
  it('round-trips every action', () => {
    for (const action of ['confirm', 'reschedule', 'cancel'] as const)
      expect(parseReminderActionId(reminderActionId(action, ID, 3))).toEqual({ action, appointmentId: ID, version: 3 });
  });

  it('refuses forged and foreign ids', () => {
    for (const id of [`appt:z:${ID}:3`, `appt:c:${ID}:0`, `appt:c:${ID}:-1`, `appt:c:not-a-uuid:3`, `codc:${ID}:yes`,
      `appt:c:${ID}:3:extra`, `appt:c:${ID}:3' OR 1=1`, null, 42, 'x'.repeat(100)])
      expect(parseReminderActionId(id), String(id)).toBeNull();
  });
});

describe('decideReminderAction', () => {
  const tap = (action: 'confirm' | 'reschedule' | 'cancel', over: Partial<{ contactId: string; version: number }> = {}) =>
    ({ contactId: CONTACT, version: 3, action, ...over });

  it('ignores another contact and a missing booking', () => {
    expect(decideReminderAction(row, tap('cancel', { contactId: OTHER }), 120, now)).toBe('not_ours');
    expect(decideReminderAction(null, tap('confirm'), 120, now)).toBe('not_ours');
    expect(decideReminderAction({ ...row, contact_id: null }, tap('confirm'), 120, now)).toBe('not_ours');
  });

  it('answers a stale version or a booking no longer confirmed', () => {
    expect(decideReminderAction(row, tap('confirm', { version: 2 }), 120, now)).toBe('stale');
    expect(decideReminderAction({ ...row, status: 'cancelled' }, tap('reschedule'), 120, now)).toBe('stale');
  });

  it('confirms once', () => {
    expect(decideReminderAction(row, tap('confirm'), 120, now)).toBe('confirm');
    expect(decideReminderAction({ ...row, attendance_confirmed_at: now }, tap('confirm'), 120, now)).toBe('already_confirmed');
  });

  it('applies the customer cut-off to cancel and reschedule, not to confirm', () => {
    const late = new Date(row.start_at.getTime() - 60 * 60_000);
    expect(decideReminderAction(row, tap('cancel'), 120, late)).toBe('too_late');
    expect(decideReminderAction(row, tap('reschedule'), 120, late)).toBe('too_late');
    expect(decideReminderAction(row, tap('confirm'), 120, late)).toBe('confirm');
    expect(decideReminderAction(row, tap('cancel'), 120, now)).toBe('cancel');
    expect(decideReminderAction(row, tap('reschedule'), 120, now)).toBe('reschedule');
    expect(customerCanChange(row, 120, new Date(row.start_at.getTime() - 120 * 60_000))).toBe(true);
  });

  it('treats a replayed cancel as already answered, with no reply', () => {
    const cancelled = { ...row, status: 'cancelled' as const, version: 4, cancel_reason: 'customer' as const };
    expect(decideReminderAction(cancelled, tap('cancel'), 120, now)).toBe('already_cancelled');
    expect(replyKey('already_cancelled')).toBeNull();
    expect(replyKey('cancel')).toBeNull();
    expect(replyKey('stale')).toBe('actionStale');
  });
});

describe('reminderChannel (Instagram fallback table)', () => {
  it.each([
    [true, true, true, 'instagram'],
    [true, true, false, 'instagram'],
    [true, false, true, 'whatsapp'],
    [true, false, false, 'window_closed'],
    [false, false, true, 'whatsapp'],
    [false, false, false, 'no_address'],
  ] as const)('instagram=%s open=%s whatsapp=%s -> %s', (instagramThread, instagramOpen, whatsappAddress, expected) => {
    expect(reminderChannel({ instagramThread, instagramOpen, whatsappAddress })).toBe(expected);
  });
});

describe('intake form decisions', () => {
  it('needs a confirmed booking with a contact and a form', () => {
    expect(intakeApplies(null, 'f')).toBe('stale_version');
    expect(intakeApplies({ status: 'cancelled', contact_id: CONTACT }, 'f')).toBe('stale_version');
    expect(intakeApplies({ status: 'confirmed', contact_id: null }, 'f')).toBe('contact_missing');
    expect(intakeApplies({ status: 'confirmed', contact_id: CONTACT }, null)).toBe('disabled');
    expect(intakeApplies({ status: 'confirmed', contact_id: CONTACT }, 'f')).toBeNull();
  });

  it('records refusals as skipped or failed, never outcome_unknown', () => {
    expect(intakeRefusalOutcome('window_closed')).toEqual({ status: 'skipped', reason: 'window_closed' });
    expect(intakeRefusalOutcome('form_not_published')).toEqual({ status: 'failed', reason: 'form_unavailable' });
  });
});

describe('appointment_reminder_actions preset', () => {
  it('is a Utility template an appointment reminder can use, with three quick replies in order', () => {
    const tpl = getLibraryTemplate(REMINDER_ACTIONS_TEMPLATE)!;
    expect(tpl.name).toBe(REMINDER_ACTIONS_TEMPLATE);
    expect(tpl.category).toBe('Utility');
    expect(actionButtonIndexes(tpl)).toEqual([0, 1, 2]);
    expect(appointmentTemplateRefusal({ ...tpl, category: 'UTILITY', header_type: 'text', header_content: tpl.header!.text,
      header_media_url: null, template_kind: null, cards: null, lto: null } as never, 'https://app.test')).toBeNull();
  });

  it('is not an actions template with a variable URL button or the wrong number of quick replies', () => {
    expect(actionButtonIndexes({ buttons: [{ type: 'QUICK_REPLY', text: 'a' }] })).toBeNull();
    expect(actionButtonIndexes({ buttons: [
      { type: 'QUICK_REPLY', text: 'a' }, { type: 'QUICK_REPLY', text: 'b' }, { type: 'QUICK_REPLY', text: 'c' },
      { type: 'URL', text: 'd', url: 'https://app.test/my-booking/{{1}}' },
    ] })).toBeNull();
  });
});
