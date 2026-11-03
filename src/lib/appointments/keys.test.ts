import { describe, expect, it } from 'vitest';
import { appointmentKeys, lockKeys, lockOrder, reminderKeyPrefix, sourceRefs } from './keys';

const ID = '11111111-1111-4111-8111-111111111111';

describe('appointment keys', () => {
  it('uses one versioned format for job and intent keys', () => {
    expect(appointmentKeys.reminder(ID, 3, '24h')).toBe(`appt-rem:${ID}:v3:24h`);
    expect(appointmentKeys.reminder(ID, 3, '2h')).toBe(`appt-rem:${ID}:v3:2h`);
    expect(appointmentKeys.notify(ID, 2, 'confirmation')).toBe(`appt-ntf:${ID}:v2:confirmation`);
    expect(appointmentKeys.event(ID, 1, 'held')).toBe(`appt-evt:${ID}:v1:held`);
    expect(appointmentKeys.holdExpire(ID, 1)).toBe(`appt-hold:${ID}:v1`);
    expect(appointmentKeys.feedback(ID, 4)).toBe(`appt-fbk:${ID}:v4`);
    expect(appointmentKeys.rebook(ID, 4)).toBe(`appt-rbk:${ID}:v4`);
  });

  it('every reminder of an appointment shares the retirement prefix, and versions never collide', () => {
    expect(appointmentKeys.reminder(ID, 1, '24h').startsWith(reminderKeyPrefix(ID))).toBe(true);
    expect(appointmentKeys.reminder(ID, 1, '2h')).not.toBe(appointmentKeys.reminder(ID, 12, '2h'));
    expect(appointmentKeys.reminder(ID, 1, '24h')).not.toBe(appointmentKeys.reminder(ID, 12, '4h' as '2h'));
  });

  it('builds idempotency references', () => {
    expect(sourceRefs.flow('run-1', 'node_a', 7)).toBe('flow:run-1:node_a:7');
    expect(sourceRefs.public('page-1', 'req-1')).toBe('public:page-1:req-1');
  });

  it('orders lock keys uniquely and deterministically', () => {
    const a = lockKeys.staff('acct', 'b-staff');
    const b = lockKeys.staff('acct', 'a-staff');
    const c = lockKeys.contact('acct', 'contact');
    expect(lockOrder([a, b, c, a])).toEqual([b, a, c].sort());
    expect(lockOrder([c, b, a])).toEqual(lockOrder([a, b, c]));
    expect(lockKeys.pool('acct', 's', 'l')).toBe('appt:acct:pool:s:l');
    expect(lockKeys.config('acct', 's', 'l')).toBe('appt:cfg:acct:s:l');
  });
});
