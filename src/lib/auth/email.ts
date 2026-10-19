import nodemailer from 'nodemailer';
import { AuthError } from './errors';

export function authEmailTransport() {
  if (!process.env.SMTP_URL || !process.env.AUTH_EMAIL_FROM)
    throw new AuthError('Authentication email delivery is not configured', 503, 'email_unavailable');
  const options = { url: process.env.SMTP_URL, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 };
  return nodemailer.createTransport(options);
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
