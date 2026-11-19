/**
 * Store plan Phase 8, batch 6: the one way shop email leaves. It reuses the platform's SMTP (SMTP_URL and AUTH_EMAIL_FROM, the
 * same transport as sign-in and billing mail, src/lib/auth/email.ts); there is no per-workspace SMTP. With either variable
 * missing the shop is "not connected" and nothing is ever sent.
 *
 * Unsubscribe links carry a token: <account>.<contact>.<HMAC>, the HMAC keyed from ENCRYPTION_KEY (a different derivation from
 * the storefront links). It proves the link was made by us for that contact, never expires (an unsubscribe link must keep
 * working) and grants nothing but "stop emailing me". Server-only.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { authEmailTransport } from '@/lib/auth/email';
import { appOrigin } from '@/lib/auth/csrf';
import { UNSUBSCRIBE_TOKEN } from './email-rules';

/** SMTP and the app address are configured (the same checks the billing email job makes). */
export function emailConnected(): boolean {
  if (!process.env.SMTP_URL || !process.env.AUTH_EMAIL_FROM) return false;
  try { appOrigin(); return true; } catch { return false; }
}

/** The bare address of AUTH_EMAIL_FROM ("Name <a@b.c>" or "a@b.c"); the shop's own name goes in front of it. */
export function fromAddress(): string {
  const from = process.env.AUTH_EMAIL_FROM ?? '';
  const angle = /<([^<>\s]+)>/.exec(from);
  return (angle ? angle[1] : from).trim();
}

function unsubscribeKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENCRYPTION_KEY must be a 32-byte hex key');
  return Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.alloc(0), 'shop-email-unsubscribe', 32));
}

const sign = (accountId: string, contactId: string) => createHmac('sha256', unsubscribeKey()).update(`${accountId}:${contactId}`).digest('base64url');

export function unsubscribeToken(accountId: string, contactId: string): string {
  return `${accountId.toLowerCase()}.${contactId.toLowerCase()}.${sign(accountId.toLowerCase(), contactId.toLowerCase())}`;
}

/** The ids a token names, when its signature checks out; null otherwise. */
export function readUnsubscribeToken(token: unknown): { accountId: string; contactId: string } | null {
  if (typeof token !== 'string' || !UNSUBSCRIBE_TOKEN.test(token)) return null;
  const [accountId, contactId, signature] = token.split('.');
  const expected = Buffer.from(sign(accountId, contactId)), given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? { accountId, contactId } : null;
}

/** The page a contact opens from the email; the shop handle is only part of the path (the token names the workspace). */
export function unsubscribeUrl(handle: string | null, token: string): string {
  return `${appOrigin()}/unsubscribe/${handle ?? 'shop'}?t=${token}`;
}

export interface ShopMail {
  to: string;
  subject: string;
  text: string;
  senderName: string | null;
  replyTo: string | null;
  /** A marketing email carries the List-Unsubscribe header. */
  unsubscribe?: string;
}

/** One message through the platform SMTP. Throws when it fails; the caller records the outcome (never log the address or the error text). */
export async function sendShopMail(mail: ShopMail): Promise<void> {
  const transport = authEmailTransport();
  try {
    await transport.sendMail({
      from: mail.senderName ? { name: mail.senderName, address: fromAddress() } : fromAddress(),
      to: mail.to, subject: mail.subject, text: mail.text,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      ...(mail.unsubscribe ? { headers: { 'List-Unsubscribe': `<${mail.unsubscribe}>` } } : {}),
    });
  } finally {
    transport.close();
  }
}
