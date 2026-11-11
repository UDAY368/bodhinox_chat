import { describe, expect, it } from 'vitest';
import { PAY_BUTTON_TITLE, paymentCard, paymentCardPayload } from './payment-card';

const URL = 'https://rzp.io/i/abc';

describe('paymentCard', () => {
  it('is the message with one Pay now URL button', () => {
    expect(paymentCard('  Total 499  ', URL)).toEqual({ text: 'Total 499', buttons: [{ type: 'web_url', title: PAY_BUTTON_TITLE, url: URL }] });
  });

  it('has a default message when there is none', () => {
    expect(paymentCard(null, URL)?.text).toBe('Here is your payment link.');
    expect(paymentCard('   ', URL)?.text).toBe('Here is your payment link.');
  });

  it('is null for a non-https link or a message over 640 characters', () => {
    expect(paymentCard('Pay', 'http://example.com')).toBeNull();
    expect(paymentCard('x'.repeat(641), URL)).toBeNull();
    expect(paymentCard('x'.repeat(640), URL)).not.toBeNull();
  });

  it('stores the URL on the button, not in the text', () => {
    const card = paymentCard('Pay', URL)!;
    const payload = paymentCardPayload(card);
    expect(payload).toMatchObject({ body: 'Pay', buttons: [{ url: URL, title: 'Pay now' }] });
    expect(JSON.stringify(payload.body)).not.toContain(URL);
  });
});
