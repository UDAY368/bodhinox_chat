import { expect, it } from 'vitest';
import { authorizeMemberChange, validateInviteHash } from './membership-policy';
it('protects the owner and rejects escalating an admin to owner', () => {
  expect(() => authorizeMemberChange('admin', 'owner', 'remove')).toThrow();
  expect(() =>
    authorizeMemberChange('admin', 'agent', 'set', 'owner')
  ).toThrow();
  expect(() => authorizeMemberChange('viewer', 'agent', 'remove')).toThrow();
  expect(() =>
    authorizeMemberChange('admin', 'agent', 'set', 'viewer')
  ).not.toThrow();
});
it('requires owner authority to transfer ownership', () => {
  expect(() => authorizeMemberChange('admin', 'agent', 'transfer')).toThrow();
  expect(() =>
    authorizeMemberChange('owner', 'agent', 'transfer')
  ).not.toThrow();
});
it('only accepts hashed invite tokens', () => {
  expect(() => validateInviteHash('plaintext-secret')).toThrow();
  expect(() => validateInviteHash('a'.repeat(64))).not.toThrow();
});
