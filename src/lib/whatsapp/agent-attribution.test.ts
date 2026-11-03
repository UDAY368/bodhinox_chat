import { describe, expect, it } from 'vitest';
import { agentSenderId } from './agent-attribution';

describe('agentSenderId', () => {
  const member = '11111111-1111-4111-8111-111111111111';

  it('stamps the sending member on an agent send', () => {
    expect(agentSenderId('agent', member)).toBe(member);
  });

  it('leaves bot sends unattributed even when they run under a member id', () => {
    expect(agentSenderId('bot', member)).toBeNull();
    expect(agentSenderId('bot', undefined)).toBeNull();
  });

  it('leaves an agent send without a member (public API) unattributed', () => {
    expect(agentSenderId('agent', undefined)).toBeNull();
    expect(agentSenderId('agent', '')).toBeNull();
  });
});
