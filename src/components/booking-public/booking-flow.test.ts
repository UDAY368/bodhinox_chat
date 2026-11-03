import { describe, expect, it } from 'vitest';
import { serviceSelection } from './booking-flow';

const loc = (id: string) => ({ id });

describe('serviceSelection', () => {
  const single = { id: 'svc-1', locations: [loc('loc-1')] };
  const multi = { id: 'svc-2', locations: [loc('loc-a'), loc('loc-b')] };

  it('re-clicking the chosen service changes nothing (it used to clear the only location for good)', () => {
    expect(serviceSelection('svc-1', single)).toBeNull();
  });

  it('a service with one location gets that location at once', () => {
    expect(serviceSelection(null, single)).toEqual({ serviceId: 'svc-1', locationId: 'loc-1' });
    expect(serviceSelection('svc-2', single)).toEqual({ serviceId: 'svc-1', locationId: 'loc-1' });
  });

  it('a service with several locations waits for the customer to pick one', () => {
    expect(serviceSelection('svc-1', multi)).toEqual({ serviceId: 'svc-2', locationId: null });
  });
});
