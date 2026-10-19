import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: vi.fn(async (_account: string, url: string) => url) }));
import { providerMediaUrl } from '@/lib/storage/server';
import { assertInteractiveTargets, bindInteractiveActions } from './interactive-actions';
import type { DataClient } from '@/lib/data/types';
import type { InteractiveButtonsPayload } from './interactive';

const id = '11111111-1111-4111-8111-111111111111';
const base: InteractiveButtonsPayload = { kind: 'buttons', body: 'Choose', buttons: [{ id: 'start', title: 'Start', action: { type: 'automation', targetId: id } }] };
function client(rows: Record<string, unknown>[]): DataClient {
  return { from(table: string) {
    const filters: Record<string, unknown> = { table };
    const query = {
      select() { return query; }, eq(key: string, value: unknown) { filters[key] = value; return query; },
      async maybeSingle() { return { data: rows.find(row => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }; },
    };
    return query;
  } } as unknown as DataClient;
}
describe('interactive action authorization and sent-message bindings', () => {
  it('requires the selected workflow to be active and owned by the sending account', async () => {
    const db = client([{ table: 'automations', account_id: 'account-a', id, is_active: true }]);
    await expect(assertInteractiveTargets(db, 'account-a', base)).resolves.toBeUndefined();
    await expect(assertInteractiveTargets(db, 'account-b', base)).rejects.toThrow(/unavailable/);
    await expect(assertInteractiveTargets(client([{ table: 'automations', account_id: 'account-a', id, is_active: false }]), 'account-a', base)).rejects.toThrow(/inactive/);
  });
  it('checks flow status independently and authorizes private media in the account', async () => {
    const flow: InteractiveButtonsPayload = { ...base, media: { type: 'image', url: '/api/media/object?bucket=flow-media&key=picture.jpg' }, buttons: [{ id: 'flow', title: 'Start', action: { type: 'flow', targetId: id } }] };
    await expect(assertInteractiveTargets(client([{ table: 'flows', account_id: 'account-a', id, status: 'active' }]), 'account-a', flow)).resolves.toBeUndefined();
    expect(providerMediaUrl).toHaveBeenCalledWith('account-a', flow.media && flow.media.type !== 'location' ? flow.media.url : '');
    await expect(assertInteractiveTargets(client([{ table: 'flows', account_id: 'account-a', id, status: 'draft' }]), 'account-a', flow)).rejects.toThrow();
  });
  it('gives workflow buttons fresh opaque IDs without altering saved quick replies or legacy flow IDs', () => {
    const first = bindInteractiveActions(base) as InteractiveButtonsPayload;
    const second = bindInteractiveActions(base) as InteractiveButtonsPayload;
    expect(first.buttons[0].id).toMatch(/^qr_[0-9a-f-]{36}$/);
    expect(first.buttons[0].id).not.toBe(second.buttons[0].id);
    expect(first.buttons[0].action).toEqual(base.buttons[0].action);
    expect(base.buttons[0].id).toBe('start');
    const legacy: InteractiveButtonsPayload = { kind: 'buttons', body: 'Choose', buttons: [{ id: 'flow-edge', title: 'Next' }] };
    expect(bindInteractiveActions(legacy)).toEqual(legacy);
  });
});
