// The Instagram form of a payment link (Stage 3, 3D): the message with a
// "Pay now" URL button (a button template: text plus a link button) instead of
// a bare URL in the text. WhatsApp keeps the plain text from
// paymentLinkMessageText. Pure: no I/O.
import { buttonTemplateFits, type IgTemplateButton } from '@/lib/instagram/graph-limits';

/**
 * shortcut: the button title is fixed English. The message above it is the
 * workspace's own text (any language); a per-workspace title can follow the
 * live capture of how Instagram renders the button.
 */
export const PAY_BUTTON_TITLE = 'Pay now';
/** Shown when the step has no message of its own. */
const DEFAULT_MESSAGE = 'Here is your payment link.';

export interface PaymentCard {
  text: string;
  buttons: IgTemplateButton[];
}

/**
 * The card for a payment link, or null when it cannot be one (the link is not
 * https, or the message is over the button template's 640 characters) and the
 * caller sends the plain text with the URL in it instead.
 */
export function paymentCard(message: string | null | undefined, shortUrl: string): PaymentCard | null {
  const card: PaymentCard = {
    text: (message ?? '').trim() || DEFAULT_MESSAGE,
    buttons: [{ type: 'web_url', title: PAY_BUTTON_TITLE, url: shortUrl }],
  };
  return buttonTemplateFits(card.text, card.buttons) ? card : null;
}

/** What the message row stores for a sent card (the URL stays on the button, as for any button template). */
export function paymentCardPayload(card: PaymentCard): Record<string, unknown> {
  return {
    kind: 'buttons',
    body: card.text,
    buttons: card.buttons.map((b) => (b.type === 'web_url' ? { url: b.url, title: b.title } : { id: b.payload, title: b.title })),
    ig: { button_template: true, payment_link: true },
  };
}
