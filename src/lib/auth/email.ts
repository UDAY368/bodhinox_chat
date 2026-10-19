import nodemailer, { type SendMailOptions } from 'nodemailer';
import { AuthError } from './errors';

export function authEmailTransport() {
  if (!process.env.SMTP_URL || !process.env.AUTH_EMAIL_FROM)
    throw new AuthError('Authentication email delivery is not configured', 503, 'email_unavailable');
  const options = { url: process.env.SMTP_URL, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 };
  return nodemailer.createTransport(options);
}

export async function sendAuthEmail(message: SendMailOptions): Promise<void> {
  const transport = authEmailTransport();
  try { await transport.sendMail(message); }
  catch (error) {
    const failure = error as { code?: string; responseCode?: number };
    // Provider error messages can contain recipient or credential material.
    console.error('Authentication email delivery failed', {
      code: failure.code && /^[A-Z_]{2,30}$/.test(failure.code) ? failure.code : 'EMAIL_DELIVERY_FAILED',
      responseCode: typeof failure.responseCode === 'number' ? failure.responseCode : undefined,
    });
    throw new AuthError('Verification email could not be sent. Please try again; if the problem continues, contact the workspace owner.', 503, 'email_delivery_failed');
  } finally { transport.close(); }
}

/** Safe SMTP status for workspace owners; never return provider responses or credentials. */
export async function checkAuthEmailTransport() {
  const transport = authEmailTransport();
  try {
    await transport.verify();
    return { configured: true, connected: true };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { configured: true, connected: false, code: code && /^[A-Z_]{2,30}$/.test(code) ? code : 'EMAIL_CONNECTION_FAILED' };
  } finally { transport.close(); }
}
