import { describe, expect, it } from 'vitest';

import { copyMondayToWeekdays, workspaceErrors } from './workspace-section';
import { quietHoursError } from './notification-preferences';
import { auditQuery, categoryFor } from './audit-log/audit-log-table';
import { stateFor } from './integrations-section';
import { categoryOf } from '@/lib/audit/audit-log';

describe('Workspace section', () => {
  it('copies Monday to Tuesday through Friday, leaving the weekend', () => {
    const hours = { mon: [{ start: '08:00', end: '17:00' }], sat: [{ start: '10:00', end: '14:00' }], tue: [] };
    const copied = copyMondayToWeekdays(hours);
    for (const day of ['tue', 'wed', 'thu', 'fri'] as const) expect(copied[day]).toEqual([{ start: '08:00', end: '17:00' }]);
    expect(copied.sat).toEqual(hours.sat);
    expect(copied.tue).not.toBe(copied.mon);
  });

  it('marks a missing name and a closing time before the opening time', () => {
    expect(workspaceErrors({ name: ' ', default_language: null, timezone: 'UTC', working_hours: { mon: [{ start: '18:00', end: '09:00' }] } }))
      .toEqual({ name: 'nameRequired', 'mon.0': 'closeAfterOpen' });
    expect(workspaceErrors({ name: 'A', default_language: 'es', timezone: 'UTC', working_hours: { mon: [{ start: '09:00', end: '24:00' }] } })).toEqual({});
  });
});

describe('Notifications section', () => {
  it('asks for two different quiet-hours times only when quiet hours are on', () => {
    const quiet = { enabled: true, start: '22:00', end: '22:00', time_zone: 'UTC', allow_mentions: true };
    expect(quietHoursError(quiet)).toBe('sameTimes');
    expect(quietHoursError({ ...quiet, enabled: false })).toBeNull();
    expect(quietHoursError({ ...quiet, end: '07:00' })).toBeNull();
  });
});

describe('Audit log section', () => {
  it('builds the list and export query from the filters', () => {
    expect(auditQuery({ q: ' team ', category: 'team', actor: '', action: '', from: '', to: '' }, 'c1')).toBe('q=team&category=team&cursor=c1');
    expect(auditQuery({ q: '', category: '', actor: '', action: '', from: '', to: '' }, null)).toBe('');
  });

  it('labels rows with the same categories the server filters by', () => {
    for (const action of ['team.created', 'whatsapp_number.disconnected', 'settings.billing', 'auth.google_linked', 'integrations.zoom_connect', 'settings.workspace', 'contacts.export'])
      expect(categoryFor(action) || null, action).toBe(categoryOf(action));
  });
});

describe('Integrations section', () => {
  it('shows the worst state of a kind, or nothing when it is not connected', () => {
    const row = (kind: 'shopify' | 'razorpay', state: 'ok' | 'attention' | 'disconnected') =>
      ({ kind, id: kind + state, label: null, status: 'x', state, lastSuccessAt: null, lastErrorCode: null, tokenExpiresAt: null, href: '' });
    expect(stateFor([row('shopify', 'ok'), row('shopify', 'attention')], 'shopify')).toBe('attention');
    expect(stateFor([row('shopify', 'ok')], 'shopify')).toBe('ok');
    expect(stateFor([row('shopify', 'ok')], 'razorpay')).toBeNull();
    expect(stateFor(null, 'shopify')).toBeNull();
  });
});
