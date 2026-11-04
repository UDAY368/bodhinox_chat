import { describe, expect, it } from 'vitest';

import { ShipmentError } from '@/lib/fulfilment/types';
import { lifecycleErrorResponse } from './http';

describe('lifecycleErrorResponse', () => {
  it('passes a live-shipment refusal through as 409 shipment_live', async () => {
    const res = lifecycleErrorResponse(new ShipmentError('shipment_live'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('shipment_live');
  });

  it('keeps an unknown error a 500 with no detail', async () => {
    const res = lifecycleErrorResponse(new Error('secret detail'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret detail');
  });
});
