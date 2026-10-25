import { describe, expect, it } from 'vitest';
import { pickBestPhoneMatch } from './dedupe';

describe('contact selection', () => {
  it('prefers an exact normalized phone over an earlier trunk variant', () => {
    const candidates = [{ id: 'variant', phone: '370063949836' }, { id: 'exact', phone: '+370 639 49836' }];
    expect(pickBestPhoneMatch(candidates, '37063949836')?.id).toBe('exact');
  });
  it('does not match unrelated numbers with the same last eight digits', () => {
    expect(pickBestPhoneMatch([{ phone: '44763949836' }], '37063949836')).toBeNull();
  });
});
