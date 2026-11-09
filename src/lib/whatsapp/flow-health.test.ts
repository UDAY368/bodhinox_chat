import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlowHealth, getWabaPhoneNumberIds } from './meta-api';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('getFlowHealth', () => {
  it('reads the status, the owning account and why each entity cannot send', async () => {
    fetchMock.mockResolvedValueOnce(json({
      status: 'PUBLISHED', whatsapp_business_account: { id: '111' },
      health_status: { can_send_message: 'BLOCKED', entities: [
        { entity_type: 'FLOW', id: '999', can_send_message: 'AVAILABLE' },
        { entity_type: 'PHONE_NUMBER', id: '222', can_send_message: 'BLOCKED',
          errors: [{ error_code: 131009, error_description: 'Not in this account', possible_solution: 'Use a number of the account' }] },
      ] },
    }));
    const health = await getFlowHealth({ flowId: '999', accessToken: 'test-only-token' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/999?fields=status,health_status,whatsapp_business_account');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-only-token');
    expect(health).toEqual({
      status: 'PUBLISHED', wabaId: '111', canSendMessage: 'BLOCKED',
      entities: [
        { entityType: 'FLOW', id: '999', canSendMessage: 'AVAILABLE', errors: [] },
        { entityType: 'PHONE_NUMBER', id: '222', canSendMessage: 'BLOCKED',
          errors: [{ code: 131009, description: 'Not in this account', solution: 'Use a number of the account' }] },
      ],
    });
  });

  it('copes with a response without health data', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await getFlowHealth({ flowId: '1', accessToken: 't' })).toEqual({ status: 'UNKNOWN', wabaId: null, canSendMessage: null, entities: [] });
  });
});

describe('getWabaPhoneNumberIds', () => {
  it('lists the phone number ids and refuses a non-numeric account id before any request', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: '222' }, { id: '333' }, { nope: 1 }] }));
    expect(await getWabaPhoneNumberIds({ wabaId: '111', accessToken: 't' })).toEqual(['222', '333']);
    await expect(getWabaPhoneNumberIds({ wabaId: '../x', accessToken: 't' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getTokenApp', () => {
  it('names the app the access token was issued for', async () => {
    const { getTokenApp } = await import('./meta-api');
    fetchMock.mockResolvedValueOnce(json({ id: '968136646348395', name: 'Bodhinox_chat' }));
    expect(await getTokenApp('t')).toEqual({ id: '968136646348395', name: 'Bodhinox_chat' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/app?fields=id,name');
  });
});

describe('number state, account flows and business accounts', () => {
  it('reads the number mode, lists flows and owned accounts, and refuses non-numeric ids before any request', async () => {
    const { getPhoneNumberState, listWabaFlows, listBusinessWabaIds } = await import('./meta-api');
    fetchMock.mockResolvedValueOnce(json({ account_mode: 'LIVE', platform_type: 'CLOUD_API', status: 'CONNECTED', extra: 'x' }));
    expect(await getPhoneNumberState({ phoneNumberId: '222', accessToken: 't' })).toMatchObject({ account_mode: 'LIVE', platform_type: 'CLOUD_API', status: 'CONNECTED', name_status: null });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/222?fields=account_mode,platform_type');
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: '9', name: 'Form', status: 'PUBLISHED' }, { name: 'no id' }] }));
    expect(await listWabaFlows({ wabaId: '111', accessToken: 't' })).toEqual([{ id: '9', name: 'Form', status: 'PUBLISHED' }]);
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: '111' }, { id: '112' }] }));
    expect(await listBusinessWabaIds({ businessId: '5', accessToken: 't' })).toEqual(['111', '112']);
    expect((fetchMock.mock.calls[2] as [string])[0]).toContain('/5/owned_whatsapp_business_accounts');
    await expect(getPhoneNumberState({ phoneNumberId: '1/x', accessToken: 't' })).rejects.toThrow();
    await expect(listWabaFlows({ wabaId: '../x', accessToken: 't' })).rejects.toThrow();
    await expect(listBusinessWabaIds({ businessId: 'a', accessToken: 't' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
