import { describe, expect, it } from 'vitest';

import { parseReviewKey } from './review';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseReviewKey', () => {
  it('reads each module key into its kind and ids', () => {
    expect(parseReviewKey(`order:${A}:dispatched`)).toMatchObject({ kind: 'order', ref1: A, subKind: 'dispatched', ref2: null });
    expect(parseReviewKey(`appt-rem:${A}:v3:24h`)).toMatchObject({ kind: 'appointment', ref1: A, version: 3, subKind: '24h' });
    expect(parseReviewKey(`appt-fbk:${A}:v2`)).toMatchObject({ kind: 'appointment', version: 2, subKind: 'feedback' });
    expect(parseReviewKey(`appt-rbk:${A}:v2`)).toMatchObject({ kind: 'appointment', subKind: 'rebook' });
    expect(parseReviewKey(`commerce:${A}`)).toMatchObject({ kind: 'store_event', ref1: A });
    expect(parseReviewKey(`flow:${A}:node_1:0:0`)).toMatchObject({ kind: 'flow', ref1: A });
    expect(parseReviewKey(`flow-api:${A}:node_1:0:0`)).toMatchObject({ kind: 'flow' });
    expect(parseReviewKey(`contact-event:${A}:${B}:x`)).toMatchObject({ kind: 'rule', ref2: B });
    expect(parseReviewKey(`automation:${A}:step`)).toMatchObject({ kind: 'rule' });
    expect(parseReviewKey(`broadcast:${A}:${B}:text:0`)).toMatchObject({ kind: 'campaign', ref1: A, ref2: B });
    expect(parseReviewKey(`scheduled-reply:${A}`)).toMatchObject({ kind: 'scheduled_reply', ref1: A });
    expect(parseReviewKey('shop-otp:abc')).toMatchObject({ kind: 'other', ref1: null });
  });

  it('never takes a non-uuid part as an id', () => {
    expect(parseReviewKey("order:1' OR 1=1:x")).toMatchObject({ kind: 'order', ref1: null });
    expect(parseReviewKey(`appt-rem:${A}:vX:24h`)).toMatchObject({ version: null });
  });
});
