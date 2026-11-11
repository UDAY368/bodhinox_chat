import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/lib/auth/client', () => ({ authFetch: h.authFetch }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: null }) }));

import {
  ChannelsSaveError,
  loadWorkspaceChannels,
  resetWorkspaceChannelsForTests,
  saveWorkspaceChannels,
  workspaceChannelsSnapshotForTests as snapshot,
} from './use-workspace-channels';

const A = '11111111-1111-4111-8111-111111111111';
const B = '33333333-3333-4333-8333-333333333333';
const state = (enabled: string[]) => ({ channels: {}, enabled, chosen: true });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  resetWorkspaceChannelsForTests();
  h.authFetch.mockReset();
});

describe('workspace channel state (shared copy)', () => {
  it('fetches once per workspace and refetches on demand', async () => {
    h.authFetch.mockResolvedValue(json(state(['whatsapp'])));
    await Promise.all([loadWorkspaceChannels(A), loadWorkspaceChannels(A)]);
    await loadWorkspaceChannels(A);
    expect(h.authFetch).toHaveBeenCalledTimes(1);
    expect(snapshot(A)).toMatchObject({ data: state(['whatsapp']), loading: false, error: false });
    await loadWorkspaceChannels(A, true);
    expect(h.authFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good copy and flags the error when a load fails', async () => {
    h.authFetch.mockResolvedValueOnce(json(state(['whatsapp'])));
    await loadWorkspaceChannels(A);
    h.authFetch.mockResolvedValueOnce(json({ error: 'x' }, 500));
    await loadWorkspaceChannels(A, true);
    expect(snapshot(A)).toMatchObject({ data: state(['whatsapp']), loading: false, error: true });
  });

  it('never shows one workspace\'s state in another after a switch', async () => {
    let resolveA!: (r: Response) => void;
    h.authFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveA = resolve; }));
    const slowA = loadWorkspaceChannels(A);
    h.authFetch.mockResolvedValueOnce(json(state(['instagram'])));
    await loadWorkspaceChannels(B);
    resolveA(json(state(['whatsapp'])));
    await slowA;
    expect(snapshot(B).data).toEqual(state(['instagram']));
    expect(snapshot(A).data).toBeNull();
  });

  it('saves through PUT and publishes the new state', async () => {
    h.authFetch.mockResolvedValueOnce(json(state(['whatsapp', 'instagram'])));
    await expect(saveWorkspaceChannels(A, { instagram: true })).resolves.toEqual(state(['whatsapp', 'instagram']));
    const [url, init] = h.authFetch.mock.calls[0];
    expect(url).toBe('/api/account/channels');
    expect(init).toMatchObject({ method: 'PUT', body: JSON.stringify({ channels: { instagram: true } }) });
    expect(snapshot(A).data).toEqual(state(['whatsapp', 'instagram']));
  });

  it('throws the server\'s message and code when a rule refuses the save, and keeps the old state', async () => {
    h.authFetch.mockResolvedValueOnce(json(state(['whatsapp'])));
    await loadWorkspaceChannels(A);
    h.authFetch.mockResolvedValueOnce(json({ error: 'Disconnect WhatsApp first', code: 'channel_connected', channel: 'whatsapp' }, 409));
    const error = await saveWorkspaceChannels(A, { whatsapp: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelsSaveError);
    expect(error).toMatchObject({ message: 'Disconnect WhatsApp first', code: 'channel_connected', status: 409 });
    expect(snapshot(A).data).toEqual(state(['whatsapp']));
  });
});
