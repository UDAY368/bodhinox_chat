// Invariant 3: inbound messages, opt-outs and payment / billing webhooks keep
// working in every plan and lifecycle state. Admin suspension and the manual
// block live in the send gates (src/lib/billing/suspension.ts) and the inbox
// send route only; none of these entry points may consult them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const INBOUND = [
  'src/app/api/whatsapp/webhook/route.ts',
  'src/app/api/meta/instagram-webhook/route.ts',
  'src/app/api/meta/page-webhook/route.ts',
  'src/app/api/payments/razorpay/webhook/[accountId]/route.ts',
  'src/app/api/billing/webhook/route.ts',
  'src/lib/whatsapp/inbound-actions.ts',
  'src/lib/contacts/consent.ts',
];
const GATES = /@\/lib\/billing\/suspension|@\/lib\/platform\/lifecycle|account_lifecycle|block_manual|isSuspended|requireSendingAllowed|assertOutboundAllowed/;

describe('inbound paths never consult suspension or the manual block', () => {
  it.each(INBOUND)('%s', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(GATES);
  });

  it('the manual block is checked only by the inbox send route', () => {
    const route = readFileSync('src/app/api/whatsapp/send/route.ts', 'utf8');
    expect(route).toMatch(/manualRepliesBlocked\(/);
    expect(route).toMatch(/workspace_manual_blocked/);
  });
});
